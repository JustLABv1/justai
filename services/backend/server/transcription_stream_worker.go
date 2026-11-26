package server

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"justai-backend/outbound"
	"justai-backend/provider"
	"justai-backend/streamrelay"
)

var errTranscriptionStreamStopped = errors.New("transcription stream stopped")
var errTranscriptionStreamEnded = errors.New("live stream ended")

func (m *TranscriptionManager) streamSourceSchedulerLoop(ctx context.Context) {
	m.startConfiguredStreamSources(ctx)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.startConfiguredStreamSources(ctx)
			m.refreshFollowedPlans(ctx)
			m.refreshTopicPlans(ctx)
			if m.app != nil {
				m.app.runTopicSubscriptionsSoon(false)
			}
		}
	}
}

func (m *TranscriptionManager) startConfiguredStreamSources(ctx context.Context) {
	if m.DB == nil {
		return
	}
	rows, err := m.DB.QueryContext(ctx, `
		SELECT source.session_id, source.id, stream.status, stream.start_mode
		FROM transcription_stream_sources stream
		JOIN transcription_sources source ON source.id = stream.source_id
		JOIN transcription_sessions session ON session.id = source.session_id
		WHERE (stream.status IN ('watching', 'pending', 'connecting', 'connected', 'reconnecting')
		       OR (stream.status = 'scheduled' AND stream.scheduled_start_at <= now()))
		  AND source.status <> 'stopped'
		  AND session.status IN ('waiting', 'live', 'paused')`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sessionID, sourceID uuid.UUID
		var status, startMode string
		if rows.Scan(&sessionID, &sourceID, &status, &startMode) == nil {
			if status == "scheduled" {
				// A watch window starts listening for the broadcast; the session clock
				// starts only once speech is heard.
				next := "pending"
				if startMode == "when_live" {
					next = "watching"
				}
				result, updateErr := m.DB.ExecContext(ctx, `UPDATE transcription_stream_sources SET status = $2, updated_at = now() WHERE source_id = $1 AND status = 'scheduled' AND scheduled_start_at <= now()`, sourceID, next)
				if updateErr != nil {
					continue
				}
				claimed, _ := result.RowsAffected()
				if claimed == 0 {
					continue
				}
				if next == "pending" {
					m.app.activateTranscriptionIngressSession(sessionID)
				}
			}
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
	var scheduledStartAt, scheduledEndAt sql.NullTime
	var reconnectGraceSeconds, silenceStopSeconds int
	var model, startMode, streamStatus string
	var recordAudio, topicsOnly bool
	if err := m.DB.QueryRowContext(ctx, `
		SELECT stream.url_ciphertext, stream.protocol, session.transcription_endpoint_id,
		       COALESCE(session.transcription_model, ''), session.language, session.status,
		       session.record_audio, stream.scheduled_start_at, stream.scheduled_end_at,
		       stream.reconnect_grace_seconds, stream.start_mode, stream.silence_stop_seconds, stream.status, stream.capture_scope = 'topics'
		FROM transcription_stream_sources stream
		JOIN transcription_sources source ON source.id = stream.source_id
		JOIN transcription_sessions session ON session.id = source.session_id
		WHERE stream.source_id = $1 AND source.session_id = $2`, sourceID, sessionID).Scan(&encryptedURL, &protocol, &endpointID, &model, &language, &sessionStatus, &recordAudio, &scheduledStartAt, &scheduledEndAt, &reconnectGraceSeconds, &startMode, &silenceStopSeconds, &streamStatus, &topicsOnly); err != nil {
		return err
	}
	if sessionStatus == "completed" || sessionStatus == "processing" {
		return errTranscriptionStreamStopped
	}
	if scheduledEndAt.Valid && !scheduledEndAt.Time.After(time.Now()) {
		if streamStatus == "watching" {
			m.watchMissed(sessionID, sourceID)
			return errTranscriptionStreamStopped
		}
		m.finishLiveStream(sessionID, sourceID, "scheduled end reached")
		return errTranscriptionStreamStopped
	}
	if reconnectGraceSeconds <= 0 {
		reconnectGraceSeconds = defaultLiveStreamReconnectGraceSeconds
	}
	// A watching source re-reads its end time from the database (a followed plan may move
	// it), so its deadline is applied only once capture begins.
	if scheduledEndAt.Valid && streamStatus != "watching" {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, scheduledEndAt.Time)
		defer cancel()
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
	if routed, routeErr := m.routeBundestagChannel(ctx, sourceID, streamURL); routeErr != nil {
		m.setStreamStatus(sessionID, sourceID, "failed", routeErr.Error(), false)
		return routeErr
	} else {
		streamURL = routed
	}
	relay, relayErr := streamrelay.ForSource(streamURL)
	if relayErr != nil {
		return relayErr
	}
	if relay == nil {
		if err := provider.ValidateMediaSourceURL(streamURL, m.Config.AllowPrivate); err != nil {
			m.setStreamStatus(sessionID, sourceID, "failed", err.Error(), false)
			return err
		}
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

	if streamStatus == "watching" {
		if err := m.watchForLiveSpeech(ctx, sessionID, sourceID, streamURL); err != nil {
			return err
		}
		scheduledEndAt = sql.NullTime{}
		if err := m.DB.QueryRowContext(ctx, `SELECT scheduled_end_at FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&scheduledEndAt); err != nil {
			return err
		}
		if scheduledEndAt.Valid {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, scheduledEndAt.Time)
			defer cancel()
		}
	}
	var guard *silenceGuard
	if silenceStopSeconds > 0 {
		guard = newSilenceGuard(time.Duration(silenceStopSeconds) * time.Second)
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
			// A topic-scoped capture pauses by rescheduling itself; keep that state.
			if streamStatus != "failed" && streamStatus != "scheduled" {
				m.setStreamStatus(sessionID, sourceID, "reconnecting", "", false)
			}
		}
		m.flushPCM(sessionID, sourceID)
		m.clearPCM(sourceID)
	}()

	var sourceOffset atomic.Int64
	sourceOffset.Store(m.continueSourceOffset(ctx, sessionID, sourceID))
	reconnectDeadline := time.Now().Add(time.Duration(reconnectGraceSeconds) * time.Second)
	for {
		if scheduledEndAt.Valid && !time.Now().Before(scheduledEndAt.Time) {
			m.finishLiveStream(sessionID, sourceID, "scheduled end reached")
			return errTranscriptionStreamStopped
		}
		if err := m.liveStreamSessionStatus(ctx, sessionID); err != nil {
			if scheduledEndAt.Valid && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				m.finishLiveStream(sessionID, sourceID, "scheduled end reached")
				return errTranscriptionStreamStopped
			}
			return err
		}
		stream, openErr := m.openVideoTranscriptionStream(ctx, endpoint, mode, language)
		if openErr != nil {
			m.markSource(sessionID, sourceID, "disconnected")
			m.setStreamStatus(sessionID, sourceID, "reconnecting", redactTranscriptionStreamError(openErr, streamURL), true)
			if !time.Now().Before(reconnectDeadline) {
				m.abortLiveStream(sessionID, sourceID, "stream was unavailable for the reconnect grace period", reconnectGraceSeconds)
				return errTranscriptionStreamStopped
			}
			if err := waitTranscriptionStreamReconnect(ctx, m.Config.Transcription.LiveStreamReconnectSeconds); err != nil {
				return err
			}
			continue
		}
		resolved, resolveErr := resolveLiveStream(ctx, streamURL, m.Config.AllowPrivate)
		if resolveErr != nil {
			stream.Close()
			m.setStreamStatus(sessionID, sourceID, "reconnecting", redactTranscriptionStreamError(resolveErr, streamURL), true)
			if !time.Now().Before(reconnectDeadline) {
				m.setStreamAlert(sessionID, sourceID, "capture_aborted", "Capture stopped: the livestream page could not be resolved.")
				m.setStreamStatus(sessionID, sourceID, "failed", "livestream page could not be resolved at capture time", false)
				return resolveErr
			}
			if err := waitTranscriptionStreamReconnect(ctx, m.Config.Transcription.LiveStreamReconnectSeconds); err != nil {
				return err
			}
			continue
		}
		mediaURL, _ := url.Parse(resolved.URL)
		connected, attemptErr := m.runLiveStreamAttempt(ctx, stream, resolved.URL, mediaURL.Scheme, mode, sessionID, sourceID, &sourceOffset, recordingStreamID, &recordingPart, guard, topicsOnly)
		if connected {
			reconnectDeadline = time.Now().Add(time.Duration(reconnectGraceSeconds) * time.Second)
		}
		if errors.Is(attemptErr, errLiveSilence) {
			liveStreamEvents.inc("silence_stop")
			m.setStreamAlert(sessionID, sourceID, "silence_stop_note", fmt.Sprintf("Capture ended automatically: no speech was heard for %d minutes.", silenceStopSeconds/60))
			m.finishLiveStream(sessionID, sourceID, "no speech for the configured time")
			return errTranscriptionStreamStopped
		}
		if errors.Is(attemptErr, errTranscriptionStreamEnded) {
			m.finishLiveStream(sessionID, sourceID, "stream ended")
			return errTranscriptionStreamStopped
		}
		if errors.Is(attemptErr, errTranscriptionStreamStopped) || errors.Is(attemptErr, context.Canceled) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return attemptErr
		}
		if err := m.liveStreamSessionStatus(ctx, sessionID); err != nil {
			if scheduledEndAt.Valid && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				m.finishLiveStream(sessionID, sourceID, "scheduled end reached")
				return errTranscriptionStreamStopped
			}
			return err
		}
		m.markSource(sessionID, sourceID, "disconnected")
		m.setStreamStatus(sessionID, sourceID, "reconnecting", redactTranscriptionStreamError(attemptErr, streamURL), true)
		if !time.Now().Before(reconnectDeadline) {
			m.abortLiveStream(sessionID, sourceID, "stream did not recover within the reconnect grace period", reconnectGraceSeconds)
			return errTranscriptionStreamStopped
		}
		if err := waitTranscriptionStreamReconnect(ctx, m.Config.Transcription.LiveStreamReconnectSeconds); err != nil {
			return err
		}
	}
}

func (m *TranscriptionManager) runLiveStreamAttempt(ctx context.Context, stream provider.TranscriptionStream, streamURL, protocol, mode string, sessionID, sourceID uuid.UUID, sourceOffset *atomic.Int64, recordingID uuid.UUID, recordingPart *int, guard *silenceGuard, topicsOnly bool) (connected bool, resultErr error) {
	attemptCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	baseOffset := sourceOffset.Load()
	eventsDone := make(chan error, 1)
	go func() {
		var eventErr error
		var topicCall topicCallBuffer
		for event := range stream.Events() {
			if event.Err != nil {
				if eventErr == nil {
					eventErr = event.Err
				}
				cancel()
				continue
			}
			rawText := firstNonEmptyString(event.RawText, event.Text)
			textValue := provider.SanitizeTranscriptRepetition(provider.CleanTranscriptText(event.Text))
			if textValue == "" || isTranscriptionProtocolPayload(textValue) {
				continue
			}
			if event.Kind == "partial" {
				// A provisional segment can straddle an unconfirmed agenda change.
				if topicsOnly {
					continue
				}

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
			announcement := topicCall.candidate(textValue, startOffset, endOffset)
			if topicsOnly {
				opened := m.observeTopics(persistCtx, sessionID, sourceID, announcement, startOffset)
				var selected bool
				err := m.DB.QueryRowContext(persistCtx, `SELECT EXISTS (
					SELECT 1 FROM transcription_topics WHERE session_id = $1
					AND (source_id IS NULL OR source_id = $2) AND status = 'active' AND starred
				)`, sessionID, sourceID).Scan(&selected)
				if err != nil {
					eventErr = err
					cancel()
					continue
				}
				if !selected {
					continue
				}
				if boundary := topicTrigger.FindStringIndex(textValue); opened && boundary != nil && boundary[0] > 0 {
					// Keep the announcement but discard speech preceding it in the same result.
					textValue = textValue[boundary[0]:]
					rawText = textValue
				}
			}
			segment, persistErr := m.app.persistTranscriptionSegmentWithRaw(persistCtx, sessionID, sourceID, textValue, rawText, startOffset, endOffset)
			if persistErr != nil {
				if eventErr == nil {
					eventErr = persistErr
				}
				cancel()
				continue
			}
			m.broadcast(sessionID, "transcription.final", ginData{"sourceId": sourceID, "segment": segment})
			m.observeSpeakers(persistCtx, sessionID, sourceID, segment.ID, textValue)
			if !topicsOnly {
				m.observeTopics(persistCtx, sessionID, sourceID, announcement, startOffset)
			}
		}
		eventsDone <- eventErr
	}()

	decoder, err := openLivePCM(attemptCtx, streamURL, protocol)
	if err != nil {
		stream.Close()
		<-eventsDone
		return connected, err
	}
	defer decoder.Close()
	stdout := decoder.reader

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
				if guard != nil && guard.feed(pcm16) {
					resultErr = errLiveSilence
					break
				}
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
			waitErr := decoder.wait()
			if waitErr != nil && attemptCtx.Err() == nil {
				resultErr = fmt.Errorf("live stream decoder stopped: %s", redactTranscriptionStreamError(fmt.Errorf("%s", firstNonEmptyString(strings.TrimSpace(decoder.stderr.String()), waitErr.Error())), streamURL))
				return connected, resultErr
			}
			if attemptCtx.Err() != nil {
				if ctx.Err() != nil {
					return connected, ctx.Err()
				}
				return connected, attemptCtx.Err()
			}
			if commitErr := stream.Commit(); commitErr != nil {
				return connected, commitErr
			}
			return connected, errTranscriptionStreamEnded
		}
		if readErr != nil {
			cancel()
			_ = decoder.wait()
			if ctx.Err() != nil {
				return connected, ctx.Err()
			}
			return connected, readErr
		}
		if attemptCtx.Err() != nil {
			_ = decoder.wait()
			if ctx.Err() != nil {
				return connected, ctx.Err()
			}
			return connected, attemptCtx.Err()
		}
	}
	return connected, resultErr
}

func (m *TranscriptionManager) finishLiveStream(sessionID, sourceID uuid.UUID, reason string) {
	m.finishLiveStreamWith(sessionID, sourceID, reason, "")
}

// finishLiveStreamWith stops a capture; endReason "aborted" marks one that ended because
// the stream failed rather than as planned.
func (m *TranscriptionManager) finishLiveStreamWith(sessionID, sourceID uuid.UUID, reason, endReason string) {
	now := time.Now().UTC()
	m.finishTopicsAtStreamEnd(sessionID, sourceID)
	_, _ = m.DB.Exec(`UPDATE transcription_stream_sources SET status = 'stopped', last_error = '', end_reason = $3,
		outage_seconds = outage_seconds + CASE WHEN interrupted_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM $2 - interrupted_at))::int ELSE 0 END,
		outage_history = CASE WHEN interrupted_at IS NOT NULL THEN outage_history || jsonb_build_array(
			jsonb_build_object('startedAt', interrupted_at, 'endedAt', GREATEST(interrupted_at, $2))
		) ELSE outage_history END,
		interrupted_at = NULL, updated_at = $2 WHERE source_id = $1`, sourceID, now, endReason)
	_, _ = m.DB.Exec(`UPDATE transcription_sources SET status = 'stopped', updated_at = $2 WHERE id = $1`, sourceID, now)
	result, _ := m.DB.Exec(`UPDATE transcription_sessions SET status = 'completed', ended_at = COALESCE(ended_at, $2), join_code_hash = NULL, join_code_expires_at = NULL, updated_at = $2 WHERE id = $1 AND status IN ('waiting', 'live', 'paused') AND NOT EXISTS (SELECT 1 FROM transcription_sources other WHERE other.session_id = $1 AND other.id <> $3 AND other.status <> 'stopped')`, sessionID, now, sourceID)
	m.markSource(sessionID, sourceID, "stopped")
	m.broadcastStreamState(sessionID, sourceID, ginData{"reason": reason})
	if result != nil {
		completed, _ := result.RowsAffected()
		if completed > 0 {
			m.broadcast(sessionID, "transcription.session", ginData{"id": sessionID, "status": "completed", "endedAt": now})
		}
	}
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
	// An outage starts when a connected capture begins to reconnect and ends when it is
	// connected again; the total tells the user where the transcript has gaps.
	_, _ = m.DB.Exec(`UPDATE transcription_stream_sources SET status = $2, last_error = $3,
		reconnect_count = CASE WHEN $4 THEN LEAST(reconnect_count + 1, 2147480000) ELSE reconnect_count END,
		last_seen_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_seen_at END,
		outage_count = outage_count + CASE WHEN $2 = 'reconnecting' AND interrupted_at IS NULL AND status = 'connected' THEN 1 ELSE 0 END,
		outage_seconds = outage_seconds + CASE WHEN $2 IN ('connected', 'stopped', 'failed', 'scheduled', 'watching') AND interrupted_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM now() - interrupted_at))::int ELSE 0 END,
		outage_history = CASE WHEN $2 IN ('connected', 'stopped', 'failed', 'scheduled', 'watching') AND interrupted_at IS NOT NULL
			THEN outage_history || jsonb_build_array(jsonb_build_object('startedAt', interrupted_at, 'endedAt', GREATEST(interrupted_at, now())))
			ELSE outage_history END,
		interrupted_at = CASE WHEN $2 = 'reconnecting' THEN COALESCE(interrupted_at, CASE WHEN status = 'connected' THEN now() END)
			WHEN $2 IN ('connected', 'stopped', 'failed', 'scheduled', 'watching') THEN NULL ELSE interrupted_at END,
		updated_at = now()
		WHERE source_id = $1 AND (status <> 'stopped' OR $2 = 'stopped')`, sourceID, status, strings.TrimSpace(lastError), incrementReconnect)
	m.broadcastStreamState(sessionID, sourceID, nil)
}

// broadcastStreamState sends the stored transport state of a stream source, merged with extra.
func (m *TranscriptionManager) broadcastStreamState(sessionID, sourceID uuid.UUID, extra ginData) {
	var reconnectCount, outageCount, outageSeconds int
	var outageHistory json.RawMessage
	var lastSeenAt, interruptedAt *time.Time
	var currentStatus, currentError, endReason string
	if err := m.DB.QueryRow(`SELECT status, reconnect_count, last_seen_at, last_error, interrupted_at, outage_count, outage_seconds, end_reason, outage_history FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&currentStatus, &reconnectCount, &lastSeenAt, &currentError, &interruptedAt, &outageCount, &outageSeconds, &endReason, &outageHistory); err != nil {
		return
	}
	data := ginData{"sourceId": sourceID, "status": currentStatus, "lastError": currentError, "reconnectCount": reconnectCount, "lastSeenAt": lastSeenAt,
		"interruptedAt": interruptedAt, "outageCount": outageCount, "outageSeconds": outageSeconds, "outageHistory": outageHistory, "endReason": endReason}
	for key, value := range extra {
		data[key] = value
	}
	m.broadcast(sessionID, "transcription.stream", data)
}

// abortLiveStream ends a capture whose stream did not come back, and says so where the
// user looks: on the session and in the library.
func (m *TranscriptionManager) abortLiveStream(sessionID, sourceID uuid.UUID, reason string, graceSeconds int) {
	m.setStreamAlert(sessionID, sourceID, "capture_aborted", fmt.Sprintf("Capture stopped: the stream did not come back within %d minutes.", max(1, graceSeconds/60)))
	m.finishLiveStreamWith(sessionID, sourceID, reason, "aborted")
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

// livePCMDecoder shares the existing recording/VAD/transcription path for local
// FFmpeg and finite relay segments.
type livePCMDecoder struct {
	reader io.ReadCloser
	wait   func() error
	cancel context.CancelFunc
	stderr *strings.Builder
}

func (d *livePCMDecoder) Close() { d.cancel(); _ = d.reader.Close(); _ = d.wait() }
func openLivePCM(ctx context.Context, raw, protocol string) (*livePCMDecoder, error) {
	ctx, cancel := context.WithCancel(ctx)
	relay, err := streamrelay.ForSource(raw)
	if err != nil {
		cancel()
		return nil, err
	}
	if relay != nil {
		return &livePCMDecoder{reader: relay.Open(ctx), wait: func() error { return ctx.Err() }, cancel: cancel, stderr: &strings.Builder{}}, nil
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", ffmpegLiveAudioArgs(raw, protocol)...)
	env, err := outbound.MediaProxyEnv(raw)
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Env = env
	stderr := &strings.Builder{}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		cancel()
		_ = stdout.Close()
		return nil, fmt.Errorf("start live stream decoder: %w", err)
	}
	return &livePCMDecoder{reader: stdout, wait: sync.OnceValue(cmd.Wait), cancel: cancel, stderr: stderr}, nil
}
