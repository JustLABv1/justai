package server

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"justai-backend/provider"
)

var errTranscriptionStreamStopped = errors.New("transcription stream stopped")

func (m *TranscriptionManager) startConfiguredStreamSources(ctx context.Context) {
	if m.DB == nil {
		return
	}
	rows, err := m.DB.QueryContext(ctx, `
		SELECT source.session_id, source.id
		FROM transcription_stream_sources stream
		JOIN transcription_sources source ON source.id = stream.source_id
		JOIN transcription_sessions session ON session.id = source.session_id
		WHERE stream.status IN ('pending', 'connecting', 'connected', 'reconnecting')
		  AND source.status <> 'stopped'
		  AND session.status IN ('waiting', 'live', 'paused')`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sessionID, sourceID uuid.UUID
		if rows.Scan(&sessionID, &sourceID) == nil {
			m.startStreamSource(sessionID, sourceID)
		}
	}
}

func (m *TranscriptionManager) startStreamSource(sessionID, sourceID uuid.UUID) {
	m.mu.Lock()
	if _, running := m.streamCancels[sourceID]; running {
		m.mu.Unlock()
		return
	}
	root := m.rootCtx
	if root == nil {
		root = context.Background()
	}
	ctx, cancel := context.WithCancel(root)
	m.streamCancels[sourceID] = cancel
	m.mu.Unlock()

	go func() {
		defer func() {
			m.mu.Lock()
			delete(m.streamCancels, sourceID)
			m.mu.Unlock()
		}()
		if err := m.runStreamSource(ctx, sessionID, sourceID); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, errTranscriptionStreamStopped) {
			m.broadcast(sessionID, "error", ginData{"sourceId": sourceID, "message": err.Error()})
		}
	}()
}

func (m *TranscriptionManager) stopStreamSource(sourceID uuid.UUID) {
	m.mu.Lock()
	cancel := m.streamCancels[sourceID]
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (m *TranscriptionManager) stopStreamSources(sessionID uuid.UUID) {
	if m.DB == nil {
		return
	}
	rows, err := m.DB.Query(`SELECT stream.source_id FROM transcription_stream_sources stream JOIN transcription_sources source ON source.id = stream.source_id WHERE source.session_id = $1`, sessionID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID uuid.UUID
		if rows.Scan(&sourceID) == nil {
			m.stopStreamSource(sourceID)
		}
	}
}

func (m *TranscriptionManager) runStreamSource(ctx context.Context, sessionID, sourceID uuid.UUID) error {
	var encryptedURL []byte
	var protocol, language, sessionStatus string
	var endpointID uuid.NullUUID
	var model string
	var recordAudio bool
	if err := m.DB.QueryRowContext(ctx, `
		SELECT stream.url_ciphertext, stream.protocol, session.transcription_endpoint_id,
		       COALESCE(session.transcription_model, ''), session.language, session.status,
		       session.record_audio
		FROM transcription_stream_sources stream
		JOIN transcription_sources source ON source.id = stream.source_id
		JOIN transcription_sessions session ON session.id = source.session_id
		WHERE stream.source_id = $1 AND source.session_id = $2`, sourceID, sessionID).Scan(&encryptedURL, &protocol, &endpointID, &model, &language, &sessionStatus, &recordAudio); err != nil {
		return err
	}
	if sessionStatus == "completed" || sessionStatus == "processing" {
		return errTranscriptionStreamStopped
	}
	if !endpointID.Valid {
		m.setStreamStatus(sessionID, sourceID, "failed", "transcription endpoint is not configured", false)
		return fmt.Errorf("transcription endpoint is not configured")
	}
	streamURL, err := m.Secrets.Decrypt(encryptedURL)
	if err != nil {
		m.setStreamStatus(sessionID, sourceID, "failed", "live stream URL could not be decrypted", false)
		return fmt.Errorf("live stream URL could not be decrypted")
	}
	if err := provider.ValidateMediaSourceURL(streamURL, m.Config.AllowPrivate); err != nil {
		m.setStreamStatus(sessionID, sourceID, "failed", err.Error(), false)
		return err
	}
	endpoint, err := m.app.providerEndpoint(ctx, endpointID.UUID)
	if err != nil {
		m.setStreamStatus(sessionID, sourceID, "failed", "transcription endpoint could not be loaded", false)
		return err
	}
	endpoint.TranscriptionModel = firstNonEmptyString(model, endpoint.TranscriptionModel)
	mode := transcriptionMode(endpoint)
	if mode == "" {
		message := fmt.Sprintf("provider %s does not support a compatible transcription transport", endpoint.ProviderType)
		m.setStreamStatus(sessionID, sourceID, "failed", message, false)
		return fmt.Errorf("%s", message)
	}

	m.setStreamStatus(sessionID, sourceID, "connecting", "", false)
	var recordingID uuid.UUID
	var recordingStreamID uuid.UUID
	var recordingPart int
	if recordAudio {
		if recording, recordingErr := m.startRecording(ctx, sessionID, sourceID, "audio/wav"); recordingErr == nil {
			recordingID = recording.ID
			if headerErr := m.appendRecording(ctx, recordingID, recordingPart, liveStreamWAVHeader()); headerErr != nil {
				m.broadcast(sessionID, "error", ginData{"sourceId": sourceID, "message": "source recording could not be initialized: " + headerErr.Error()})
			} else {
				recordingStreamID = recordingID
				recordingPart++
			}
		} else {
			m.broadcast(sessionID, "error", ginData{"sourceId": sourceID, "message": "source recording could not be started: " + recordingErr.Error()})
		}
	}
	defer func() {
		if recordingID != uuid.Nil {
			_ = m.completeRecording(context.WithoutCancel(ctx), recordingID)
		}
		var sourceStatus, streamStatus string
		_ = m.DB.QueryRow(`SELECT status FROM transcription_sources WHERE id = $1`, sourceID).Scan(&sourceStatus)
		_ = m.DB.QueryRow(`SELECT status FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&streamStatus)
		if sourceStatus != "stopped" {
			m.markSource(sessionID, sourceID, "disconnected")
			if streamStatus != "failed" {
				m.setStreamStatus(sessionID, sourceID, "reconnecting", "", false)
			}
		}
		m.flushPCM(sessionID, sourceID)
		m.clearPCM(sourceID)
	}()

	var sourceOffset atomic.Int64
	for {
		if err := m.liveStreamSessionStatus(ctx, sessionID); err != nil {
			return err
		}
		stream, openErr := m.openVideoTranscriptionStream(ctx, endpoint, mode, language)
		if openErr != nil {
			m.markSource(sessionID, sourceID, "disconnected")
			m.setStreamStatus(sessionID, sourceID, "reconnecting", redactTranscriptionStreamError(openErr, streamURL), true)
			if err := waitTranscriptionStreamReconnect(ctx, m.Config.Transcription.LiveStreamReconnectSeconds); err != nil {
				return err
			}
			continue
		}
		attemptErr := m.runLiveStreamAttempt(ctx, stream, streamURL, protocol, mode, sessionID, sourceID, &sourceOffset, recordingStreamID, &recordingPart)
		if errors.Is(attemptErr, errTranscriptionStreamStopped) || errors.Is(attemptErr, context.Canceled) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return attemptErr
		}
		if err := m.liveStreamSessionStatus(ctx, sessionID); err != nil {
			return err
		}
		m.markSource(sessionID, sourceID, "disconnected")
		m.setStreamStatus(sessionID, sourceID, "reconnecting", redactTranscriptionStreamError(attemptErr, streamURL), true)
		if err := waitTranscriptionStreamReconnect(ctx, m.Config.Transcription.LiveStreamReconnectSeconds); err != nil {
			return err
		}
	}
}

func (m *TranscriptionManager) runLiveStreamAttempt(ctx context.Context, stream provider.TranscriptionStream, streamURL, protocol, mode string, sessionID, sourceID uuid.UUID, sourceOffset *atomic.Int64, recordingID uuid.UUID, recordingPart *int) (resultErr error) {
	attemptCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	baseOffset := sourceOffset.Load()
	eventsDone := make(chan error, 1)
	go func() {
		var eventErr error
		for event := range stream.Events() {
			if event.Err != nil {
				if eventErr == nil {
					eventErr = event.Err
				}
				cancel()
				continue
			}
			textValue := provider.CleanTranscriptText(event.Text)
			if textValue == "" || isTranscriptionProtocolPayload(textValue) {
				continue
			}
			if event.Kind == "partial" {
				m.broadcast(sessionID, "transcription.partial", ginData{"sourceId": sourceID, "text": textValue})
				continue
			}
			if event.Kind != "final" {
				continue
			}
			textValue = provider.SanitizeTranscriptRepetition(textValue)
			if textValue == "" {
				continue
			}
			endOffset := sourceOffset.Load()
			startOffset := maxInt64(0, endOffset-3000)
			if event.EndOffsetMs > 0 {
				startOffset = baseOffset + maxInt64(0, event.StartOffsetMs)
				endOffset = baseOffset + event.EndOffsetMs
			}
			persistCtx := context.WithoutCancel(ctx)
			segment, persistErr := m.app.persistTranscriptionSegmentWithRaw(persistCtx, sessionID, sourceID, textValue, textValue, startOffset, endOffset)
			if persistErr != nil {
				if eventErr == nil {
					eventErr = persistErr
				}
				cancel()
				continue
			}
			m.broadcast(sessionID, "transcription.final", ginData{"sourceId": sourceID, "segment": segment})
		}
		eventsDone <- eventErr
	}()

	ffmpeg := exec.CommandContext(attemptCtx, "ffmpeg", ffmpegLiveAudioArgs(streamURL, protocol)...)
	var stderr strings.Builder
	ffmpeg.Stderr = &stderr
	stdout, err := ffmpeg.StdoutPipe()
	if err != nil {
		stream.Close()
		<-eventsDone
		return err
	}
	if err := ffmpeg.Start(); err != nil {
		stream.Close()
		<-eventsDone
		return fmt.Errorf("start live stream decoder: %w", err)
	}
	defer func() {
		stream.Close()
		eventErr := <-eventsDone
		if (resultErr == nil || errors.Is(resultErr, context.Canceled)) && eventErr != nil {
			resultErr = eventErr
		}
	}()
	var voiceActive bool
	lastVoiceAt := time.Time{}
	const voiceHangover = 650 * time.Millisecond
	forwardSilence := false
	if silenceForwarder, ok := stream.(provider.SilenceForwarder); ok {
		forwardSilence = silenceForwarder.ForwardSilence()
	}
	buffer := make([]byte, 64*1024)
	connected := false
	lastLevelAt := time.Time{}
	lastStatusCheck := time.Time{}
	sessionPaused := false
	for {
		read, readErr := stdout.Read(buffer)
		if read > 0 {
			chunk := append([]byte(nil), buffer[:read]...)
			pcm16 := provider.ResamplePCM16(chunk, 16000, 16000)
			if len(pcm16) > 0 {
				if lastStatusCheck.IsZero() || time.Since(lastStatusCheck) >= time.Second {
					wasPaused := sessionPaused
					var statusErr error
					sessionPaused, statusErr = m.liveStreamSessionPaused(attemptCtx, sessionID)
					lastStatusCheck = time.Now()
					if statusErr != nil {
						resultErr = statusErr
						break
					}
					if sessionPaused && !wasPaused {
						if committer, ok := stream.(provider.TurnCommitter); ok {
							if commitErr := committer.CommitTurn(); commitErr != nil {
								resultErr = commitErr
								break
							}
						}
						voiceActive = false
						m.updateSourceLevel(sessionID, sourceID, 0)
					}
				}
				if sessionPaused {
					goto readComplete
				}
				if !connected {
					connected = true
					m.markSource(sessionID, sourceID, "connected")
					m.setStreamStatus(sessionID, sourceID, "connected", "", false)
					m.broadcast(sessionID, "transcription.ready", ginData{"sessionId": sessionID, "sourceId": sourceID, "provider": streamProviderName(stream), "mode": mode})
				}
				chunkDuration := int64(len(pcm16)) * 1000 / (16000 * 2)
				sourceOffset.Add(chunkDuration)
				m.appendPCM(sessionID, sourceID, pcm16)
				if lastLevelAt.IsZero() || time.Since(lastLevelAt) >= time.Second {
					m.updateSourceLevel(sessionID, sourceID, minFloat(1, provider.PCM16RMS(pcm16)*3.2))
					lastLevelAt = time.Now()
				}
				if recordingID != uuid.Nil {
					if recordErr := m.appendRecording(context.WithoutCancel(ctx), recordingID, *recordingPart, pcm16); recordErr != nil {
						m.broadcast(sessionID, "error", ginData{"sourceId": sourceID, "message": "source recording failed: " + recordErr.Error()})
						recordingID = uuid.Nil
					} else {
						(*recordingPart)++
					}
				}
				shouldSend := forwardSilence
				if !forwardSilence {
					hasSpeech := provider.PCM16HasSpeech(pcm16)
					if hasSpeech {
						voiceActive = true
						lastVoiceAt = time.Now()
						shouldSend = true
					} else if !voiceActive || time.Since(lastVoiceAt) > voiceHangover {
						if voiceActive {
							voiceActive = false
							if committer, ok := stream.(provider.TurnCommitter); ok {
								if commitErr := committer.CommitTurn(); commitErr != nil {
									resultErr = commitErr
									break
								}
							}
						}
					} else {
						shouldSend = true
					}
				}
				if shouldSend {
					if sendErr := stream.SendPCM(attemptCtx, pcm16, 16000); sendErr != nil {
						resultErr = sendErr
						break
					}
				}
			}
		}
	readComplete:
		if readErr == io.EOF {
			waitErr := ffmpeg.Wait()
			if waitErr != nil && attemptCtx.Err() == nil {
				resultErr = fmt.Errorf("live stream decoder stopped: %s", redactTranscriptionStreamError(fmt.Errorf("%s", firstNonEmptyString(strings.TrimSpace(stderr.String()), waitErr.Error())), streamURL))
				return resultErr
			}
			if attemptCtx.Err() != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return attemptCtx.Err()
			}
			if commitErr := stream.Commit(); commitErr != nil {
				return commitErr
			}
			return fmt.Errorf("live stream ended")
		}
		if readErr != nil {
			cancel()
			_ = ffmpeg.Wait()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return readErr
		}
		if attemptCtx.Err() != nil {
			_ = ffmpeg.Wait()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return attemptCtx.Err()
		}
	}
	return resultErr
}

func (m *TranscriptionManager) liveStreamSessionStatus(ctx context.Context, sessionID uuid.UUID) error {
	_, err := m.liveStreamSessionState(ctx, sessionID)
	return err
}

func (m *TranscriptionManager) liveStreamSessionPaused(ctx context.Context, sessionID uuid.UUID) (bool, error) {
	status, err := m.liveStreamSessionState(ctx, sessionID)
	return status == "paused", err
}

func (m *TranscriptionManager) liveStreamSessionState(ctx context.Context, sessionID uuid.UUID) (string, error) {
	var status string
	if err := m.DB.QueryRowContext(ctx, `SELECT status FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&status); err != nil {
		return "", err
	}
	switch status {
	case "completed", "processing", "failed":
		return status, errTranscriptionStreamStopped
	default:
		return status, nil
	}
}

func (m *TranscriptionManager) setStreamStatus(sessionID, sourceID uuid.UUID, status, lastError string, incrementReconnect bool) {
	if incrementReconnect {
		_, _ = m.DB.Exec(`UPDATE transcription_stream_sources SET status = $2, reconnect_count = LEAST(reconnect_count + 1, 2147480000), last_error = $3, updated_at = now() WHERE source_id = $1 AND (status <> 'stopped' OR $2 = 'stopped')`, sourceID, status, strings.TrimSpace(lastError))
	} else {
		_, _ = m.DB.Exec(`UPDATE transcription_stream_sources SET status = $2, last_error = $3, last_seen_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_seen_at END, updated_at = now() WHERE source_id = $1 AND (status <> 'stopped' OR $2 = 'stopped')`, sourceID, status, strings.TrimSpace(lastError))
	}
	var reconnectCount int
	var lastSeenAt *time.Time
	var currentStatus string
	var currentError string
	if err := m.DB.QueryRow(`SELECT status, reconnect_count, last_seen_at, last_error FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&currentStatus, &reconnectCount, &lastSeenAt, &currentError); err == nil {
		m.broadcast(sessionID, "transcription.stream", ginData{"sourceId": sourceID, "status": currentStatus, "lastError": currentError, "reconnectCount": reconnectCount, "lastSeenAt": lastSeenAt})
	}
}

func waitTranscriptionStreamReconnect(ctx context.Context, seconds int) error {
	if seconds <= 0 {
		seconds = 5
	}
	timer := time.NewTimer(time.Duration(seconds) * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func ffmpegLiveAudioArgs(streamURL, protocol string) []string {
	args := []string{
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-rw_timeout",
		"15000000",
	}
	if protocol == "http" || protocol == "https" {
		args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10")
	}
	return append(args,
		"-fflags", "+discardcorrupt",
		"-i", streamURL,
		"-map", "0:a:0?",
		"-vn",
		"-sn",
		"-dn",
		"-ac", "1",
		"-ar", "16000",
		"-f", "s16le",
		"pipe:1",
	)
}

func liveStreamWAVHeader() []byte {
	const (
		sampleRate = 16000
		channels   = 1
		bits       = 16
		blockSize  = channels * bits / 8
	)
	header := make([]byte, 44)
	copy(header[0:4], "RIFF")
	// Live recordings do not know their final size when the stream begins.
	// 0xffffffff is the conventional streaming-WAV sentinel.
	binary.LittleEndian.PutUint32(header[4:8], 0xffffffff)
	copy(header[8:12], "WAVE")
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)
	binary.LittleEndian.PutUint16(header[20:22], 1)
	binary.LittleEndian.PutUint16(header[22:24], channels)
	binary.LittleEndian.PutUint32(header[24:28], sampleRate)
	binary.LittleEndian.PutUint32(header[28:32], sampleRate*blockSize)
	binary.LittleEndian.PutUint16(header[32:34], blockSize)
	binary.LittleEndian.PutUint16(header[34:36], bits)
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], 0xffffffff)
	return header
}

func redactTranscriptionStreamError(err error, rawURLs ...string) string {
	if err == nil {
		return ""
	}
	value := strings.TrimSpace(err.Error())
	if value == "" {
		return "stream decoder stopped"
	}
	for _, rawURL := range rawURLs {
		rawURL = strings.TrimSpace(rawURL)
		if rawURL != "" {
			value = strings.ReplaceAll(value, rawURL, redactTranscriptionStreamURL(rawURL))
		}
	}
	words := strings.Fields(value)
	for index, word := range words {
		trimmed := strings.Trim(word, "[](){}<>\"',;")
		if !strings.Contains(trimmed, "://") {
			continue
		}
		parsed, parseErr := url.Parse(trimmed)
		if parseErr != nil || parsed.Host == "" {
			continue
		}
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.ForceQuery = false
		parsed.Fragment = ""
		words[index] = strings.Replace(word, trimmed, parsed.String(), 1)
	}
	value = strings.Join(words, " ")
	if len(value) > 800 {
		value = value[:800] + "…"
	}
	return value
}

func redactTranscriptionStreamURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "[stream URL redacted]"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	return parsed.String()
}

func streamProviderName(stream provider.TranscriptionStream) string {
	switch stream.(type) {
	case *provider.RealtimeStream:
		return "realtime"
	case *provider.ChunkedStream:
		return "chunked"
	default:
		return "transcription"
	}
}
