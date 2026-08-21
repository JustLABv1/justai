package server

import (
	"testing"

	"justai-backend/models"
)

func TestBuildVideoAudioChunksUsesOverlappingSlices(t *testing.T) {
	totalBytes := int64(20*60*1000+3000) * videoAudioBytesPerMs
	chunks := buildVideoAudioChunks(totalBytes, 10*60*1000, 5000)
	if len(chunks) != 3 {
		t.Fatalf("got %d chunks, want 3: %+v", len(chunks), chunks)
	}
	wantStarts := []int64{0, 595000, 1190000}
	wantEnds := []int64{600000, 1195000, 1203000}
	for index, chunk := range chunks {
		if chunk.index != index || chunk.startOffsetMs != wantStarts[index] || chunk.endOffsetMs != wantEnds[index] {
			t.Fatalf("chunk %d = %+v, want index/start/end %d/%d/%d", index, chunk, index, wantStarts[index], wantEnds[index])
		}
	}
	if chunks[1].offsetBytes+chunks[1].lengthBytes-chunks[1].offsetBytes != int64(10*60*1000)*videoAudioBytesPerMs {
		t.Fatalf("middle chunk has unexpected length: %+v", chunks[1])
	}
}

func TestBuildVideoAudioChunksKeepsShortVideoAsOneSlice(t *testing.T) {
	chunks := buildVideoAudioChunks(int64(9*60*1000)*videoAudioBytesPerMs, 10*60*1000, 5000)
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want one: %+v", len(chunks), chunks)
	}
	if chunks[0].startOffsetMs != 0 || chunks[0].endOffsetMs != 9*60*1000 {
		t.Fatalf("unexpected short-video chunk: %+v", chunks[0])
	}
}

func TestMergeVideoTranscriptionEventsRemovesSliceBoundaryOverlap(t *testing.T) {
	events := []videoTranscriptionEvent{
		{chunkIndex: 1, startOffsetMs: 3500, endOffsetMs: 7000, text: "the room is live"},
		{chunkIndex: 0, startOffsetMs: 0, endOffsetMs: 4000, text: "hello from the room"},
		{chunkIndex: 1, startOffsetMs: 3600, endOffsetMs: 6800, text: "hello from the room"},
	}
	merged := mergeVideoTranscriptionEvents(events)
	if len(merged) != 2 {
		t.Fatalf("got %d merged events, want 2: %+v", len(merged), merged)
	}
	if merged[0].text != "hello from the room" || merged[1].text != "is live" {
		t.Fatalf("unexpected merged text: %+v", merged)
	}
	if merged[0].startOffsetMs != 0 || merged[1].startOffsetMs != 3500 {
		t.Fatalf("events were not sorted by absolute timestamp: %+v", merged)
	}
}

func TestAppendVideoPreviewSegmentsKeepsRecentOutputInTimestampOrder(t *testing.T) {
	progress := models.TranscriptionVideoParallelProgress{
		PreviewSegments: []models.TranscriptionVideoPreviewSegment{
			{StartOffsetMs: 6000, EndOffsetMs: 7000, Text: "later"},
		},
	}
	appendVideoPreviewSegments(&progress, []videoTranscriptionEvent{
		{startOffsetMs: 1000, endOffsetMs: 2000, text: "first"},
		{startOffsetMs: 4000, endOffsetMs: 5000, text: "middle"},
	})

	if len(progress.PreviewSegments) != 3 {
		t.Fatalf("got %d preview segments, want 3: %+v", len(progress.PreviewSegments), progress.PreviewSegments)
	}
	if progress.PreviewSegments[0].Text != "first" || progress.PreviewSegments[2].Text != "later" {
		t.Fatalf("preview segments are not ordered by timestamp: %+v", progress.PreviewSegments)
	}
}

func TestNormalizeVideoChunkEventUsesAbsoluteOffsets(t *testing.T) {
	chunk := videoAudioChunk{startOffsetMs: 595000, endOffsetMs: 1195000}
	event, ok := normalizeVideoChunkEvent(videoTranscriptionEvent{
		startOffsetMs: 1000,
		endOffsetMs:   4000,
		text:          "hello",
	}, chunk)
	if !ok {
		t.Fatal("expected event to be normalized")
	}
	if event.startOffsetMs != 596000 || event.endOffsetMs != 599000 {
		t.Fatalf("got offsets %d-%d, want 596000-599000", event.startOffsetMs, event.endOffsetMs)
	}
}
