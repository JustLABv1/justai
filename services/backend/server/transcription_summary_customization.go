package server

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"justai-backend/models"
)

func excludeSummarySourceSegments(segments []models.TranscriptionSegment, excluded []string) ([]models.TranscriptionSegment, error) {
	available := make(map[uuid.UUID]bool, len(segments))
	for _, segment := range segments {
		available[segment.ID] = true
	}
	omitted := make(map[uuid.UUID]bool, len(excluded))
	for _, value := range excluded {
		id, err := uuid.Parse(value)
		if err != nil || !available[id] {
			return nil, fmt.Errorf("excluded passage is not part of this transcript")
		}
		omitted[id] = true
	}
	result := make([]models.TranscriptionSegment, 0, len(segments))
	for _, segment := range segments {
		if !omitted[segment.ID] {
			result = append(result, segment)
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("include at least one transcript passage in the summary")
	}
	return result, nil
}

func summaryCustomInstructions(instructions []string) string {
	if len(instructions) == 0 || strings.TrimSpace(instructions[0]) == "" {
		return ""
	}
	return "\nUser's summary standard (apply to wording, focus and level of detail while preserving the required JSON schema, factual accuracy, source attribution and output language):\n" + strings.TrimSpace(instructions[0])
}

type transcriptionSummaryExportDraft struct {
	Revision    string    `json:"revision"`
	Summary     *[]string `json:"summaryParagraphs"`
	Chapters    *[]int    `json:"chapterIndices"`
	Topics      *[]int    `json:"topicIndices"`
	ActionItems *[]int    `json:"actionItemIndices"`
}

func selectSummaryExportItems[T any](items []T, indices *[]int) ([]T, error) {
	if indices == nil {
		return items, nil
	}
	selected := make([]T, 0, len(*indices))
	seen := make(map[int]bool)
	for _, index := range *indices {
		if index < 0 || index >= len(items) || seen[index] {
			return nil, fmt.Errorf("summary selection is invalid; reopen the export")
		}
		selected = append(selected, items[index])
		seen[index] = true
	}
	return selected, nil
}

func applySummaryExportDraft(insights *models.TranscriptionInsights, draft transcriptionSummaryExportDraft) (*models.TranscriptionInsights, error) {
	if draft.Summary == nil && draft.Chapters == nil && draft.Topics == nil && draft.ActionItems == nil {
		return insights, nil
	}
	if insights == nil {
		return nil, fmt.Errorf("generate a summary before customizing its export")
	}
	revision, err := time.Parse(time.RFC3339Nano, draft.Revision)
	if err != nil || !revision.Equal(insights.UpdatedAt) {
		return nil, fmt.Errorf("the summary changed; reopen the export before downloading")
	}
	result := *insights
	if draft.Summary != nil {
		size := 0
		for _, paragraph := range *draft.Summary {
			size += len(paragraph)
		}
		if size > 500000 {
			return nil, fmt.Errorf("edited summary is too large")
		}
		result.Summary = strings.Join(*draft.Summary, "\n\n")
	}
	if result.Chapters, err = selectSummaryExportItems(result.Chapters, draft.Chapters); err != nil {
		return nil, err
	}
	if result.Topics, err = selectSummaryExportItems(result.Topics, draft.Topics); err != nil {
		return nil, err
	}
	if result.ActionItems, err = selectSummaryExportItems(result.ActionItems, draft.ActionItems); err != nil {
		return nil, err
	}
	return &result, nil
}
