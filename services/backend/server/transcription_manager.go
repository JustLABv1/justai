package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"justai-backend/config"
	"justai-backend/models"
	"justai-backend/security"
)

type transcriptionClient struct {
	connection *websocket.Conn
	writeMu    sync.Mutex
	role       string
	sourceID   uuid.UUID
}

type transcriptionHub struct {
	mu       sync.Mutex
	clients  map[*transcriptionClient]struct{}
	sequence int64
}

type pcmBuffer struct {
	mu          sync.Mutex
	sessionID   uuid.UUID
	data        []byte
	startOffset int64
}

type TranscriptionManager struct {
	Config  config.Config
	DB      *sql.DB
	Secrets *security.SecretBox
	app     *App

	mu      sync.Mutex
	hubs    map[uuid.UUID]*transcriptionHub
	buffers map[uuid.UUID]*pcmBuffer
	joinMu  sync.Mutex
	joins   map[string][]time.Time
	clocks  map[uuid.UUID]int64
	epochs  map[uuid.UUID]int64

	videoDiarizationMu      sync.Mutex
	videoDiarizationCancels map[uuid.UUID]videoDiarizationCancellation
	videoDiarizationToken   uint64
}

func NewTranscriptionManager(cfg config.Config, db *sql.DB, secrets *security.SecretBox) *TranscriptionManager {
	return &TranscriptionManager{
		Config:                  cfg,
		DB:                      db,
		Secrets:                 secrets,
		hubs:                    make(map[uuid.UUID]*transcriptionHub),
		buffers:                 make(map[uuid.UUID]*pcmBuffer),
		joins:                   make(map[string][]time.Time),
		clocks:                  make(map[uuid.UUID]int64),
		epochs:                  make(map[uuid.UUID]int64),
		videoDiarizationCancels: make(map[uuid.UUID]videoDiarizationCancellation),
	}
}

func (m *TranscriptionManager) SetApp(application *App) {
	m.app = application
}

func (m *TranscriptionManager) Start(ctx context.Context) {
	go m.cleanupLoop(ctx)
	m.startVideoWorker(ctx)
}

func (m *TranscriptionManager) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.expireRecordings(ctx)
			m.expireVideoUploads(ctx)
			m.expireSessions(ctx)
			_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_join_requests SET status = 'expired', updated_at = now() WHERE status = 'pending' AND expires_at <= now()`)
		}
	}
}

func (m *TranscriptionManager) expireSessions(ctx context.Context) {
	if m.Config.Transcription.MaxSessionHours <= 0 {
		return
	}
	rows, err := m.DB.QueryContext(ctx, `UPDATE transcription_sessions SET status = 'completed', ended_at = COALESCE(ended_at, now()), join_code_hash = NULL, join_code_expires_at = NULL, updated_at = now() WHERE status IN ('waiting', 'live', 'paused') AND started_at IS NOT NULL AND started_at <= now() - ($1 * INTERVAL '1 hour') RETURNING id`, m.Config.Transcription.MaxSessionHours)
	if err != nil {
		return
	}
	var sessionIDs []uuid.UUID
	for rows.Next() {
		var sessionID uuid.UUID
		if rows.Scan(&sessionID) == nil {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	_ = rows.Close()
	for _, sessionID := range sessionIDs {
		m.flushPCMForSession(sessionID)
		m.broadcast(sessionID, "transcription.session", ginData{"status": "completed", "reason": "session limit reached"})
		m.closeSession(sessionID)
	}
}

func (m *TranscriptionManager) allowJoin(key string) bool {
	now := time.Now()
	cutoff := now.Add(-10 * time.Minute)
	m.joinMu.Lock()
	defer m.joinMu.Unlock()
	entries := m.joins[key][:0]
	for _, entry := range m.joins[key] {
		if entry.After(cutoff) {
			entries = append(entries, entry)
		}
	}
	if len(entries) >= 10 {
		m.joins[key] = entries
		return false
	}
	m.joins[key] = append(entries, now)
	return true
}

func (m *TranscriptionManager) expireRecordings(ctx context.Context) {
	rows, err := m.DB.QueryContext(ctx, `SELECT id FROM transcription_recordings WHERE expires_at IS NOT NULL AND expires_at <= now()`)
	if err != nil {
		return
	}
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()
	for _, id := range ids {
		_ = m.deleteRecording(ctx, id)
	}
}

func (m *TranscriptionManager) hub(sessionID uuid.UUID) *transcriptionHub {
	m.mu.Lock()
	defer m.mu.Unlock()
	value := m.hubs[sessionID]
	if value == nil {
		value = &transcriptionHub{clients: make(map[*transcriptionClient]struct{})}
		m.hubs[sessionID] = value
	}
	return value
}

func (m *TranscriptionManager) register(sessionID uuid.UUID, client *transcriptionClient) {
	hub := m.hub(sessionID)
	hub.mu.Lock()
	hub.clients[client] = struct{}{}
	hub.mu.Unlock()
}

func (m *TranscriptionManager) unregister(sessionID uuid.UUID, client *transcriptionClient) {
	m.mu.Lock()
	hub := m.hubs[sessionID]
	m.mu.Unlock()
	if hub == nil {
		return
	}
	hub.mu.Lock()
	delete(hub.clients, client)
	empty := len(hub.clients) == 0
	hub.mu.Unlock()
	if empty {
		m.mu.Lock()
		if current := m.hubs[sessionID]; current == hub {
			delete(m.hubs, sessionID)
		}
		m.mu.Unlock()
	}
}

func (m *TranscriptionManager) broadcast(sessionID uuid.UUID, eventType string, data any) {
	m.mu.Lock()
	hub := m.hubs[sessionID]
	m.mu.Unlock()
	if hub == nil {
		return
	}
	hub.mu.Lock()
	hub.sequence++
	sequence := hub.sequence
	clients := make([]*transcriptionClient, 0, len(hub.clients))
	for client := range hub.clients {
		clients = append(clients, client)
	}
	hub.mu.Unlock()
	for _, client := range clients {
		client.writeMu.Lock()
		_ = client.connection.WriteJSON(models.SocketEnvelope{Type: eventType, Sequence: sequence, Data: data})
		client.writeMu.Unlock()
	}
}

// closeSession terminates every websocket attached to a session. A session
// reaching a terminal state must not leave a capture connection streaming
// audio into a provider after the UI has stopped it.
func (m *TranscriptionManager) closeSession(sessionID uuid.UUID) {
	m.mu.Lock()
	hub := m.hubs[sessionID]
	m.mu.Unlock()
	if hub == nil {
		return
	}
	hub.mu.Lock()
	clients := make([]*transcriptionClient, 0, len(hub.clients))
	for client := range hub.clients {
		clients = append(clients, client)
	}
	hub.mu.Unlock()
	deadline := time.Now().Add(time.Second)
	for _, client := range clients {
		if client.role == "transcription-viewer" {
			// Viewers can keep the final transcript open after a room ends.
			continue
		}
		client.writeMu.Lock()
		_ = client.connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "session completed"), deadline)
		_ = client.connection.Close()
		client.writeMu.Unlock()
	}
}

func (m *TranscriptionManager) send(client *transcriptionClient, eventType string, data any) error {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	return client.connection.WriteJSON(models.SocketEnvelope{Type: eventType, Data: data})
}

func (m *TranscriptionManager) markSource(sessionID, sourceID uuid.UUID, status string) {
	now := time.Now().UTC()
	_, _ = m.DB.Exec(`UPDATE transcription_sources SET status = $2, connected_at = CASE WHEN $2 = 'connected' THEN COALESCE(connected_at, $3) ELSE connected_at END, last_seen_at = $3, updated_at = $3 WHERE id = $1`, sourceID, status, now)
	var source models.TranscriptionSource
	if err := m.DB.QueryRow(`SELECT id, session_id, name, kind, device_label, status, clock_offset_ms, connected_at, last_seen_at FROM transcription_sources WHERE id = $1 AND session_id = $2`, sourceID, sessionID).Scan(&source.ID, &source.SessionID, &source.Name, &source.Kind, &source.DeviceLabel, &source.Status, &source.ClockOffsetMs, &source.ConnectedAt, &source.LastSeenAt); err == nil {
		m.broadcast(sessionID, "transcription.source", ginData{"sourceId": sourceID, "status": source.Status, "lastSeenAt": now, "source": source})
		return
	}
	m.broadcast(sessionID, "transcription.source", ginData{"sourceId": sourceID, "status": status, "lastSeenAt": now})
}

func (m *TranscriptionManager) updateSourceLevel(sessionID, sourceID uuid.UUID, level float64) {
	level = maxFloat(0, minFloat(1, level))
	_, _ = m.DB.Exec(`UPDATE transcription_sources SET last_seen_at = now(), updated_at = now() WHERE id = $1`, sourceID)
	m.broadcast(sessionID, "transcription.source.level", ginData{"sourceId": sourceID, "level": level})
}

func (m *TranscriptionManager) captureOffset(sessionID, sourceID uuid.UUID, captureTimestamp int64) int64 {
	if captureTimestamp <= 0 {
		return 0
	}
	now := time.Now().UnixMilli()
	m.mu.Lock()
	clockOffset, synchronized := m.clocks[sourceID]
	if !synchronized {
		clockOffset = now - captureTimestamp
		m.clocks[sourceID] = clockOffset
	}
	correctedTimestamp := captureTimestamp + clockOffset
	epoch, hasEpoch := m.epochs[sessionID]
	if !hasEpoch {
		epoch = correctedTimestamp
		m.epochs[sessionID] = epoch
	}
	m.mu.Unlock()
	if !synchronized {
		_, _ = m.DB.Exec(`UPDATE transcription_sources SET clock_offset_ms = $2, updated_at = now() WHERE id = $1`, sourceID, clockOffset)
	}
	return maxInt64(0, correctedTimestamp-epoch)
}

func (m *TranscriptionManager) appendPCM(sessionID, sourceID uuid.UUID, pcm []byte) {
	if len(pcm) == 0 {
		return
	}
	m.mu.Lock()
	buffer := m.buffers[sourceID]
	if buffer == nil {
		buffer = &pcmBuffer{sessionID: sessionID}
		m.buffers[sourceID] = buffer
	}
	m.mu.Unlock()
	windowBytes := m.Config.Transcription.DiarizationWindow * 16000 * 2
	overlapBytes := m.Config.Transcription.DiarizationOverlap * 16000 * 2
	if windowBytes <= 0 {
		return
	}
	buffer.mu.Lock()
	buffer.data = append(buffer.data, pcm...)
	for len(buffer.data) >= windowBytes {
		window := append([]byte(nil), buffer.data[:windowBytes]...)
		startOffset := buffer.startOffset
		advance := windowBytes - overlapBytes
		if advance <= 0 {
			advance = windowBytes
		}
		buffer.data = append([]byte(nil), buffer.data[advance:]...)
		buffer.startOffset += int64(advance / (16000 * 2) * 1000)
		if m.app != nil {
			go m.app.processDiarizationWindow(sessionID, sourceID, startOffset, window)
		}
	}
	buffer.mu.Unlock()
}

func (m *TranscriptionManager) clearPCM(sourceID uuid.UUID) {
	m.mu.Lock()
	delete(m.buffers, sourceID)
	m.mu.Unlock()
}

func (m *TranscriptionManager) flushPCM(sessionID, sourceID uuid.UUID) {
	m.mu.Lock()
	buffer := m.buffers[sourceID]
	m.mu.Unlock()
	if buffer == nil {
		return
	}
	buffer.mu.Lock()
	data := append([]byte(nil), buffer.data...)
	startOffset := buffer.startOffset
	buffer.data = nil
	buffer.mu.Unlock()
	if len(data) > 0 && m.app != nil {
		go m.app.processDiarizationWindow(sessionID, sourceID, startOffset, data)
	}
	m.mu.Lock()
	delete(m.clocks, sourceID)
	m.mu.Unlock()
}

func (m *TranscriptionManager) flushPCMForSession(sessionID uuid.UUID) {
	rows, err := m.DB.Query(`SELECT id FROM transcription_sources WHERE session_id = $1`, sessionID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID uuid.UUID
		if rows.Scan(&sourceID) == nil {
			m.flushPCM(sessionID, sourceID)
			m.clearPCM(sourceID)
		}
	}
	m.mu.Lock()
	delete(m.epochs, sessionID)
	m.mu.Unlock()
}

func (m *TranscriptionManager) startRecording(ctx context.Context, sessionID, sourceID uuid.UUID, mimeType string) (models.TranscriptionRecording, error) {
	driver := m.Config.Transcription.StorageDriver
	if driver == "s3" {
		if _, err := newS3Storage(m.Config); err != nil {
			return models.TranscriptionRecording{}, err
		}
	} else if driver != "local" {
		return models.TranscriptionRecording{}, fmt.Errorf("recording storage driver %q is not supported", driver)
	}
	if mimeType == "" {
		mimeType = "audio/webm;codecs=opus"
	}
	if len(mimeType) > 128 || !strings.HasPrefix(strings.ToLower(strings.TrimSpace(mimeType)), "audio/") {
		return models.TranscriptionRecording{}, fmt.Errorf("recordings must use an audio MIME type")
	}
	if driver == "local" {
		if err := os.MkdirAll(m.Config.Transcription.LocalStoragePath, 0o700); err != nil {
			return models.TranscriptionRecording{}, err
		}
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return models.TranscriptionRecording{}, err
	}
	wrapped, err := m.Secrets.Encrypt(base64.RawStdEncoding.EncodeToString(key))
	if err != nil {
		return models.TranscriptionRecording{}, err
	}
	recordingID := uuid.New()
	storageKey := "transcription/" + recordingID.String()
	if driver == "local" {
		storageKey = recordingID.String() + ".enc"
		path := filepath.Join(m.Config.Transcription.LocalStoragePath, storageKey)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return models.TranscriptionRecording{}, err
		}
		_ = file.Close()
	}
	expiresAt := time.Now().Add(time.Duration(m.Config.Transcription.AudioRetentionDays) * 24 * time.Hour)
	var recording models.TranscriptionRecording
	err = m.DB.QueryRowContext(ctx, `INSERT INTO transcription_recordings (id, session_id, source_id, mime_type, storage_driver, storage_key, wrapped_key, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, session_id, source_id, mime_type, bytes, expires_at, completed_at`, recordingID, sessionID, sourceID, mimeType, driver, storageKey, wrapped, expiresAt).Scan(&recording.ID, &recording.SessionID, &recording.SourceID, &recording.MimeType, &recording.Bytes, &recording.ExpiresAt, &recording.CompletedAt)
	return recording, err
}

func (m *TranscriptionManager) appendRecording(ctx context.Context, recordingID uuid.UUID, part int, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	if part < 0 {
		return fmt.Errorf("recording part must not be negative")
	}
	transaction, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var storageKey string
	var wrapped []byte
	var driver string
	var completedAt sql.NullTime
	var nextPart int
	err = transaction.QueryRowContext(ctx, `SELECT storage_driver, storage_key, wrapped_key, completed_at, next_part FROM transcription_recordings WHERE id = $1 FOR UPDATE`, recordingID).Scan(&driver, &storageKey, &wrapped, &completedAt, &nextPart)
	if err != nil {
		return err
	}
	if part != nextPart {
		return fmt.Errorf("recording part %d arrived out of order; expected %d", part, nextPart)
	}
	if completedAt.Valid {
		return fmt.Errorf("recording is already complete")
	}
	secret, err := m.Secrets.Decrypt(wrapped)
	if err != nil {
		return err
	}
	key, err := base64.RawStdEncoding.DecodeString(secret)
	if err != nil {
		return err
	}
	sealed, err := sealAudioChunk(key, payload)
	if err != nil {
		return err
	}
	if driver == "local" {
		path := filepath.Join(m.Config.Transcription.LocalStoragePath, storageKey)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(sealed)))
		if _, err := file.Write(length[:]); err == nil {
			_, err = file.Write(sealed)
		}
		_ = file.Close()
		if err != nil {
			return err
		}
	} else if driver == "s3" {
		storage, err := newS3Storage(m.Config)
		if err != nil {
			return err
		}
		if err := storage.put(ctx, recordingPartKey(storageKey, part), sealed, "application/octet-stream"); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("recording storage driver %q is not supported", driver)
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_recordings SET bytes = bytes + $2, next_part = next_part + 1 WHERE id = $1`, recordingID, len(payload)); err != nil {
		return err
	}
	return transaction.Commit()
}

func (m *TranscriptionManager) completeRecording(ctx context.Context, recordingID uuid.UUID) error {
	_, err := m.DB.ExecContext(ctx, `UPDATE transcription_recordings SET completed_at = COALESCE(completed_at, now()) WHERE id = $1`, recordingID)
	return err
}

func (m *TranscriptionManager) deleteRecording(ctx context.Context, recordingID uuid.UUID) error {
	var driver, storageKey string
	if err := m.DB.QueryRowContext(ctx, `SELECT storage_driver, storage_key FROM transcription_recordings WHERE id = $1`, recordingID).Scan(&driver, &storageKey); err != nil {
		return err
	}
	if driver == "local" {
		_ = os.Remove(filepath.Join(m.Config.Transcription.LocalStoragePath, storageKey))
	} else if driver == "s3" {
		storage, err := newS3Storage(m.Config)
		if err != nil {
			return err
		}
		if err := storage.deletePrefix(ctx, storageKey+"/"); err != nil {
			return err
		}
	}
	_, err := m.DB.ExecContext(ctx, `DELETE FROM transcription_recordings WHERE id = $1`, recordingID)
	return err
}

func (m *TranscriptionManager) recordingReader(ctx context.Context, recordingID uuid.UUID) (io.ReadCloser, string, error) {
	var driver, storageKey, mimeType string
	var wrapped []byte
	if err := m.DB.QueryRowContext(ctx, `SELECT storage_driver, storage_key, mime_type, wrapped_key FROM transcription_recordings WHERE id = $1`, recordingID).Scan(&driver, &storageKey, &mimeType, &wrapped); err != nil {
		return nil, "", err
	}
	if driver == "s3" {
		storage, err := newS3Storage(m.Config)
		if err != nil {
			return nil, "", err
		}
		secret, err := m.Secrets.Decrypt(wrapped)
		if err != nil {
			return nil, "", err
		}
		key, err := base64.RawStdEncoding.DecodeString(secret)
		if err != nil {
			return nil, "", err
		}
		return &s3RecordingReader{storage: storage, prefix: storageKey, key: key}, mimeType, nil
	}
	if driver != "local" {
		return nil, "", fmt.Errorf("recording storage driver %q is not supported", driver)
	}
	secret, err := m.Secrets.Decrypt(wrapped)
	if err != nil {
		return nil, "", err
	}
	key, err := base64.RawStdEncoding.DecodeString(secret)
	if err != nil {
		return nil, "", err
	}
	file, err := os.Open(filepath.Join(m.Config.Transcription.LocalStoragePath, storageKey))
	if err != nil {
		return nil, "", err
	}
	return &encryptedRecordingReader{file: file, key: key}, mimeType, nil
}

func recordingPartKey(prefix string, part int) string {
	return prefix + "/part-" + fmt.Sprintf("%08d", part)
}

type s3RecordingReader struct {
	storage *s3Storage
	prefix  string
	key     []byte
	part    int
	current io.ReadCloser
	buffer  bytes.Buffer
	done    bool
}

func (r *s3RecordingReader) Read(target []byte) (int, error) {
	for r.buffer.Len() == 0 && !r.done {
		if r.current != nil {
			_ = r.current.Close()
			r.current = nil
		}
		object, err := r.storage.get(context.Background(), recordingPartKey(r.prefix, r.part))
		if err != nil {
			if responseError, ok := err.(*s3ResponseError); ok && responseError.status == http.StatusNotFound {
				r.done = true
				break
			}
			return 0, err
		}
		sealed, err := io.ReadAll(object)
		_ = object.Close()
		if err != nil {
			return 0, err
		}
		plain, err := openAudioChunk(r.key, sealed)
		if err != nil {
			return 0, err
		}
		_, _ = r.buffer.Write(plain)
		r.part++
	}
	if r.buffer.Len() == 0 && r.done {
		return 0, io.EOF
	}
	return r.buffer.Read(target)
}

func (r *s3RecordingReader) Close() error {
	if r.current != nil {
		return r.current.Close()
	}
	return nil
}

type encryptedRecordingReader struct {
	file *os.File
	key  []byte
	buf  bytes.Buffer
}

func (r *encryptedRecordingReader) Read(target []byte) (int, error) {
	if r.buf.Len() == 0 {
		var length [4]byte
		if _, err := io.ReadFull(r.file, length[:]); err != nil {
			return 0, err
		}
		sealed := make([]byte, binary.BigEndian.Uint32(length[:]))
		if _, err := io.ReadFull(r.file, sealed); err != nil {
			return 0, err
		}
		plain, err := openAudioChunk(r.key, sealed)
		if err != nil {
			return 0, err
		}
		_, _ = r.buf.Write(plain)
	}
	return r.buf.Read(target)
}

func (r *encryptedRecordingReader) Close() error {
	return r.file.Close()
}

func sealAudioChunk(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func openAudioChunk(key, sealed []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, fmt.Errorf("encrypted recording part is too short")
	}
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
}

func (m *TranscriptionManager) snapshotEvent(sessionID uuid.UUID) (ginData, error) {
	if m.app == nil {
		return nil, fmt.Errorf("transcription manager is not attached to the app")
	}
	snapshot, err := m.app.transcriptionSnapshot(context.Background(), sessionID)
	if err != nil {
		return nil, err
	}
	value, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var data ginData
	if err := json.Unmarshal(value, &data); err != nil {
		return nil, err
	}
	return data, nil
}

type ginData map[string]any

func minFloat(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}

func maxFloat(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}
