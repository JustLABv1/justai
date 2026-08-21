package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
)

const (
	videoDiarizationWindowMs  int64 = 60_000
	videoDiarizationOverlapMs int64 = 2_000
	videoAudioBytesPerMs      int64 = 32 // 16 kHz, mono, PCM16
)

// diarizeVideoAudio runs a second, bounded audio pass. Keeping diarization
// separate from ASR means a long video never has to be held in memory and the
// existing streaming transcription transport remains unchanged.
func (m *TranscriptionManager) diarizeVideoAudio(ctx context.Context, uploadID, sessionID uuid.UUID, storageKey string, endpointID uuid.UUID, model, language string, durationMs int64, storage *s3Storage) error {
	if m.app == nil {
		return fmt.Errorf("transcription manager is not attached to the app")
	}
	if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
		return err
	}
	endpoint, err := m.app.providerEndpoint(ctx, endpointID)
	if err != nil {
		return err
	}
	endpoint.DiarizationModel = firstNonEmptyString(model, endpoint.DiarizationModel)
	if !endpointSupports(endpoint, "diarization") {
		return fmt.Errorf("endpoint does not support diarization")
	}

	if endpoint.ProviderType == "pyannote" {
		videoURL := storage.presignProcessingURL(http.MethodGet, storageKey, nil, videoProcessingURLLifetime)
		return m.diarizeVideoWithPyannote(ctx, uploadID, sessionID, endpoint, language, videoURL)
	}
	videoURL := storage.presignURL(http.MethodGet, storageKey, nil, videoProcessingURLLifetime)
	command := exec.CommandContext(ctx, "ffmpeg", ffmpegVideoAudioArgs(videoURL)...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start ffmpeg for diarization: %w", err)
	}

	windowBytes := int(videoDiarizationWindowMs * videoAudioBytesPerMs)
	overlapBytes := int(videoDiarizationOverlapMs * videoAudioBytesPerMs)
	advanceBytes := windowBytes - overlapBytes
	audio := make([]byte, 0, windowBytes+64*1024)
	buffer := make([]byte, 64*1024)
	windowStartMs := int64(0)
	for {
		read, readErr := stdout.Read(buffer)
		if read > 0 {
			audio = append(audio, buffer[:read]...)
			for len(audio) >= windowBytes {
				if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
					_ = command.Process.Kill()
					_ = command.Wait()
					return err
				}
				window := append([]byte(nil), audio[:windowBytes]...)
				if err := m.applyVideoDiarizationWindow(ctx, sessionID, endpoint, language, windowStartMs, window); err != nil {
					_ = command.Process.Kill()
					_ = command.Wait()
					return err
				}
				if durationMs > 0 {
					progress := 86 + int(minInt64(8, windowStartMs*8/durationMs))
					if err := m.updateVideoProgress(ctx, uploadID, progress, "diarizing", ""); err != nil {
						_ = command.Process.Kill()
						_ = command.Wait()
						return err
					}
				}
				audio = append([]byte(nil), audio[advanceBytes:]...)
				windowStartMs += int64(advanceBytes) * 1000 / videoAudioBytesPerMs
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			return readErr
		}
	}
	if len(audio) >= int(250*videoAudioBytesPerMs) {
		if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			return err
		}
		if err := m.applyVideoDiarizationWindow(ctx, sessionID, endpoint, language, windowStartMs, audio); err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			return err
		}
	}
	if err := command.Wait(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("ffmpeg could not extract audio for diarization: %s", message)
	}
	if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
		return err
	}
	return nil
}

// diarizeVideoWithPyannote sends the complete recording to the dedicated
// pyannote service. Unlike rolling-window providers, pyannote must see the
// complete file in one pipeline invocation so SPEAKER_00 remains the same
// person from the beginning to the end of the recording.
func (m *TranscriptionManager) diarizeVideoWithPyannote(ctx context.Context, uploadID, sessionID uuid.UUID, endpoint provider.Endpoint, language, videoURL string) error {
	if err := m.updateVideoProgress(ctx, uploadID, 88, "diarizing", ""); err != nil {
		return err
	}
	turns, err := provider.DiarizeMediaURL(ctx, endpoint, videoURL, language)
	if err != nil {
		if skipErr := m.ensureVideoUploadActive(ctx, uploadID); errors.Is(skipErr, errVideoTranscriptionSkipDiarization) {
			return skipErr
		}
		return err
	}
	if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
		return err
	}
	segments, err := loadTranscriptionSegments(ctx, m.DB, sessionID)
	if err != nil {
		return err
	}
	if err := m.applyVideoDiarizationTurns(ctx, sessionID, segments, turns); err != nil {
		return err
	}
	_ = m.updateVideoProgress(ctx, uploadID, 94, "diarizing", "")
	return nil
}

type videoDiarizationInterval struct {
	speaker string
	start   int64
	end     int64
}

func chooseVideoDiarizationSpeaker(segmentStart, segmentEnd int64, intervals []videoDiarizationInterval) string {
	overlaps := make(map[string]int64)
	for _, interval := range intervals {
		start := maxInt64(segmentStart, interval.start)
		end := minInt64(segmentEnd, interval.end)
		if end > start {
			overlaps[interval.speaker] += end - start
		}
	}
	bestSpeaker := ""
	var bestOverlap int64
	for speaker, overlap := range overlaps {
		if overlap > bestOverlap || (overlap == bestOverlap && overlap > 0 && (bestSpeaker == "" || speaker < bestSpeaker)) {
			bestSpeaker = speaker
			bestOverlap = overlap
		}
	}
	return bestSpeaker
}

// applyVideoDiarizationTurns assigns the speaker with the greatest temporal
// overlap to each transcript segment. This is more stable than updating the
// nearest segment once per turn, especially when one ASR segment spans a
// speaker change or when pyannote reports overlapping speech.
func (m *TranscriptionManager) applyVideoDiarizationTurns(ctx context.Context, sessionID uuid.UUID, segments []models.TranscriptionSegment, turns []provider.DiarizationSegment) error {
	intervals := make([]videoDiarizationInterval, 0, len(turns))
	for _, turn := range turns {
		if strings.TrimSpace(turn.Speaker) == "" || turn.End <= turn.Start {
			continue
		}
		start := maxInt64(0, int64(turn.Start*1000))
		end := maxInt64(start+1, int64(turn.End*1000))
		intervals = append(intervals, videoDiarizationInterval{
			speaker: strings.TrimSpace(turn.Speaker),
			start:   start,
			end:     end,
		})
	}
	if len(intervals) == 0 {
		return nil
	}

	speakerIDs := make(map[string]uuid.UUID)
	for _, segment := range segments {
		if segment.SourceID != nil {
			continue
		}
		segmentStart := segment.StartOffsetMs
		segmentEnd := segment.EndOffsetMs
		if segmentEnd <= segmentStart {
			segmentEnd = segmentStart + 1
		}
		bestSpeaker := chooseVideoDiarizationSpeaker(segmentStart, segmentEnd, intervals)
		if bestSpeaker == "" {
			continue
		}
		speakerID, ok := speakerIDs[bestSpeaker]
		if !ok {
			var err error
			speakerID, err = m.app.ensureTranscriptionSpeaker(ctx, sessionID, bestSpeaker)
			if err != nil {
				return err
			}
			speakerIDs[bestSpeaker] = speakerID
		}
		if segment.SpeakerID != nil && *segment.SpeakerID == speakerID {
			continue
		}
		if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_segments SET speaker_id = $2, updated_at = now() WHERE id = $1 AND session_id = $3`, segment.ID, speakerID, sessionID); err != nil {
			return err
		}
		m.broadcast(sessionID, "transcription.segment.updated", ginData{"segmentId": segment.ID, "speakerId": speakerID})
	}
	return nil
}

func (m *TranscriptionManager) applyVideoDiarizationWindow(ctx context.Context, sessionID uuid.UUID, endpoint provider.Endpoint, language string, startOffsetMs int64, pcm []byte) error {
	windowCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	segments, err := provider.Diarize(windowCtx, endpoint, pcm, language)
	cancel()
	if err != nil {
		return err
	}
	for _, item := range segments {
		if strings.TrimSpace(item.Speaker) == "" {
			continue
		}
		start := startOffsetMs + int64(item.Start*1000)
		end := startOffsetMs + int64(item.End*1000)
		if start < startOffsetMs {
			start = startOffsetMs
		}
		if end <= start {
			end = start + 250
		}
		speakerID, err := m.app.ensureTranscriptionSpeaker(ctx, sessionID, strings.TrimSpace(item.Speaker))
		if err != nil {
			continue
		}
		var segmentID uuid.UUID
		err = m.DB.QueryRowContext(ctx, `SELECT id FROM transcription_segments WHERE session_id = $1 AND source_id IS NULL AND canonical = TRUE AND start_offset_ms <= $2 AND end_offset_ms >= $3 ORDER BY ABS(start_offset_ms - $4) LIMIT 1`, sessionID, end+2500, start-2500, start).Scan(&segmentID)
		if err != nil {
			if err == sql.ErrNoRows {
				continue
			}
			return err
		}
		if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_segments SET speaker_id = $2, updated_at = now() WHERE id = $1`, segmentID, speakerID); err != nil {
			return err
		}
		m.broadcast(sessionID, "transcription.segment.updated", ginData{"segmentId": segmentID, "speakerId": speakerID})
	}
	return nil
}

type videoPolishInput struct {
	ID      string `json:"id"`
	Speaker string `json:"speaker,omitempty"`
	Text    string `json:"text"`
}

type videoPolishOutput struct {
	Segments []videoPolishSegment `json:"segments"`
}

type videoPolishSegment struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func (m *TranscriptionManager) polishVideoTranscript(ctx context.Context, uploadID, sessionID, endpointID uuid.UUID, model string) error {
	if m.app == nil {
		return fmt.Errorf("transcription manager is not attached to the app")
	}
	endpoint, err := m.app.providerEndpoint(ctx, endpointID)
	if err != nil {
		return m.finishVideoPolish(ctx, uploadID, sessionID, fmt.Errorf("grammar endpoint could not be loaded: %w", err))
	}
	endpoint.ChatModel = firstNonEmptyString(model, endpoint.ChatModel)
	if !endpointSupports(endpoint, "chat") {
		return m.finishVideoPolish(ctx, uploadID, sessionID, fmt.Errorf("grammar endpoint does not support chat"))
	}
	segments, err := loadTranscriptionSegments(ctx, m.DB, sessionID)
	if err != nil {
		return m.finishVideoPolish(ctx, uploadID, sessionID, err)
	}
	if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET polish_status = 'processing', updated_at = now() WHERE id = $1`, sessionID); err != nil {
		return err
	}
	m.broadcast(sessionID, "transcription.polish", ginData{"status": "processing"})
	if len(segments) == 0 {
		return m.finishVideoPolish(ctx, uploadID, sessionID, nil)
	}

	if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_segments SET polished_text = NULL WHERE session_id = $1 AND source_id IS NULL`, sessionID); err != nil {
		return m.finishVideoPolish(ctx, uploadID, sessionID, err)
	}

	totalBatches := 0
	for index := 0; index < len(segments); {
		batch := make([]models.TranscriptionSegment, 0, 20)
		characters := 0
		for index < len(segments) && len(batch) < 20 {
			segment := segments[index]
			raw := strings.TrimSpace(segment.Text)
			if raw == "" {
				raw = strings.TrimSpace(segment.RawText)
			}
			if raw == "" {
				index++
				continue
			}
			if len(batch) > 0 && characters+len(raw) > 9000 {
				break
			}
			batch = append(batch, segment)
			characters += len(raw)
			index++
		}
		if len(batch) == 0 {
			continue
		}
		totalBatches++
		if err := m.polishVideoTranscriptBatch(ctx, endpoint, sessionID, batch); err != nil {
			return m.finishVideoPolish(ctx, uploadID, sessionID, err)
		}
		if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
			return m.finishVideoPolish(ctx, uploadID, sessionID, err)
		}
		progress := 95 + int(float64(totalBatches)*4/float64(maxInt64(1, int64((len(segments)+19)/20))))
		if progress > 99 {
			progress = 99
		}
		_ = m.updateVideoProgress(ctx, uploadID, progress, "polishing", "")
	}
	return m.finishVideoPolish(ctx, uploadID, sessionID, nil)
}

func (m *TranscriptionManager) polishVideoTranscriptBatch(ctx context.Context, endpoint provider.Endpoint, sessionID uuid.UUID, segments []models.TranscriptionSegment) error {
	items := make([]videoPolishInput, 0, len(segments))
	speakerNames := map[uuid.UUID]string{}
	speakers, _ := loadTranscriptionSpeakers(ctx, m.DB, sessionID)
	for _, speaker := range speakers {
		speakerNames[speaker.ID] = firstNonEmptyString(speaker.DisplayName, speaker.Label)
	}
	for _, segment := range segments {
		raw := strings.TrimSpace(segment.Text)
		if raw == "" {
			raw = strings.TrimSpace(segment.RawText)
		}
		item := videoPolishInput{ID: segment.ID.String(), Text: raw}
		if segment.SpeakerID != nil {
			item.Speaker = speakerNames[*segment.SpeakerID]
		}
		items = append(items, item)
	}
	input, err := json.Marshal(struct {
		Segments []videoPolishInput `json:"segments"`
	}{Segments: items})
	if err != nil {
		return err
	}
	system := `You are a transcript editor. Correct spelling, punctuation, capitalization, and grammar in the same language as each segment. Return exactly one JSON object in the shape {"segments":[{"id":"...","text":"..."}]}. Do not emit multiple JSON objects, markdown fences, or commentary. Preserve the meaning, names, numbers, speaker boundaries, and order. Do not summarize, translate, add facts, or remove meaningful words. Keep natural filler words unless they are clearly transcription noise.`
	var output strings.Builder
	err = provider.StreamChat(ctx, endpoint, provider.ChatOptions{
		Model: endpoint.ChatModel,
		Messages: []provider.Message{
			{Role: "system", Content: system},
			{Role: "user", Content: string(input)},
		},
	}, func(delta string) error {
		output.WriteString(delta)
		return nil
	})
	if err != nil {
		return err
	}
	polished, err := decodeVideoPolishOutput(output.String())
	if err != nil {
		return err
	}
	for id, text := range polished {
		if strings.TrimSpace(text) == "" {
			continue
		}
		if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_segments SET polished_text = $2, updated_at = now() WHERE id = $1 AND session_id = $3 AND source_id IS NULL`, id, strings.TrimSpace(text), sessionID); err != nil {
			return err
		}
	}
	return nil
}

func (m *TranscriptionManager) finishVideoPolish(ctx context.Context, uploadID, sessionID uuid.UUID, polishErr error) error {
	status := "completed"
	if polishErr != nil {
		status = "failed"
	}
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET polish_status = $2, updated_at = now() WHERE id = $1`, sessionID, status)
	if err := m.finishVideoPipelineStep(ctx, uploadID, "grammar", status, errorMessage(polishErr)); err != nil {
		slog.Warn("could not persist grammar pipeline step", "uploadId", uploadID, "error", err)
	}
	m.broadcast(sessionID, "transcription.polish", ginData{"status": status, "message": errorMessage(polishErr)})
	return polishErr
}

func decodeVideoPolishOutput(value string) (map[uuid.UUID]string, error) {
	result := make(map[uuid.UUID]string)
	var lastErr error
	for _, candidate := range videoPolishJSONCandidates(value) {
		segments, err := decodeVideoPolishJSONValue(candidate)
		if err != nil {
			lastErr = err
			continue
		}
		for _, item := range segments {
			id, err := uuid.Parse(item.ID)
			if err != nil {
				continue
			}
			result[id] = item.Text
		}
	}
	if len(result) == 0 {
		if lastErr != nil {
			return nil, fmt.Errorf("grammar endpoint returned invalid JSON: %w", lastErr)
		}
		return nil, fmt.Errorf("grammar endpoint returned no transcript segments")
	}
	return result, nil
}

// videoPolishJSONCandidates extracts complete JSON values instead of slicing
// from the first opening brace to the last closing brace. Some gateways emit
// a fenced answer, prose around the answer, or more than one JSON object when
// a streamed response is assembled. json.Decoder safely stops at each value.
func videoPolishJSONCandidates(value string) []json.RawMessage {
	trimmed := strings.TrimSpace(value)
	candidates := make([]json.RawMessage, 0, 2)
	seen := make(map[string]struct{})
	for start := 0; start < len(trimmed); start++ {
		if !strings.ContainsRune("{[\"", rune(trimmed[start])) {
			continue
		}
		var raw json.RawMessage
		decoder := json.NewDecoder(strings.NewReader(trimmed[start:]))
		if err := decoder.Decode(&raw); err != nil || len(raw) == 0 {
			continue
		}
		key := string(raw)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, raw)
	}
	return candidates
}

func decodeVideoPolishJSONValue(raw json.RawMessage) ([]videoPolishSegment, error) {
	var decoded videoPolishOutput
	if err := json.Unmarshal(raw, &decoded); err == nil && len(decoded.Segments) > 0 {
		return decoded.Segments, nil
	}
	var list []videoPolishSegment
	if err := json.Unmarshal(raw, &list); err == nil && len(list) > 0 {
		return list, nil
	}

	var segment videoPolishSegment
	if err := json.Unmarshal(raw, &segment); err == nil && segment.ID != "" {
		return []videoPolishSegment{segment}, nil
	}

	var encoded string
	if err := json.Unmarshal(raw, &encoded); err == nil && strings.TrimSpace(encoded) != "" {
		return decodeVideoPolishJSONValue(json.RawMessage(encoded))
	}

	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("JSON did not contain transcript segments")
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (m *TranscriptionManager) ensureVideoUploadActive(ctx context.Context, uploadID uuid.UUID) error {
	var status, stage string
	if err := m.DB.QueryRowContext(ctx, `SELECT status, stage FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&status, &stage); err != nil {
		return err
	}
	if status == "cancelled" {
		return errVideoTranscriptionCancelled
	}
	if stage == videoDiarizationSkipStage {
		return errVideoTranscriptionSkipDiarization
	}
	return nil
}
