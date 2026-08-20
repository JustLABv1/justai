package server

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"justai-backend/models"
)

func TestSavedAssistantValuesFromRequestUsesStableDefaults(t *testing.T) {
	name := "Meeting editor"
	instructions := "Summarize decisions and action items."
	values, err := savedAssistantValuesFromRequest(savedAssistantRequest{
		Name:         &name,
		Instructions: &instructions,
	}, nil)
	if err != nil {
		t.Fatalf("saved assistant values: %v", err)
	}
	if values.Name != name || values.Instructions != instructions {
		t.Fatalf("unexpected values: %+v", values)
	}
	if values.Icon != "sparkles" || values.Visibility != "private" || !values.UseMemory {
		t.Fatalf("unexpected defaults: %+v", values)
	}
}

func TestSavedAssistantValuesFromRequestPreservesPartialUpdates(t *testing.T) {
	endpointID := uuid.New()
	current := &models.SavedAssistant{
		Name:         "Existing assistant",
		Description:  "Existing description",
		Icon:         "bot",
		Visibility:   "workspace",
		Instructions: "Existing instructions",
		EndpointID:   &endpointID,
		Model:        "existing-model",
		UseMemory:    false,
		DeepContext:  true,
	}
	name := "Renamed assistant"
	values, err := savedAssistantValuesFromRequest(savedAssistantRequest{Name: &name}, current)
	if err != nil {
		t.Fatalf("saved assistant values: %v", err)
	}
	if values.Name != name || values.Description != current.Description || values.EndpointID == nil || *values.EndpointID != endpointID {
		t.Fatalf("partial update lost existing fields: %+v", values)
	}
	if values.UseMemory || !values.DeepContext || values.Model != current.Model {
		t.Fatalf("partial update changed existing configuration: %+v", values)
	}
}

func TestSavedAssistantValuesFromRequestRejectsInvalidConfiguration(t *testing.T) {
	name := "Assistant"
	visibility := "public"
	_, err := savedAssistantValuesFromRequest(savedAssistantRequest{
		Name:       &name,
		Visibility: &visibility,
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "visibility") {
		t.Fatalf("expected visibility validation error, got %v", err)
	}

	tooLong := strings.Repeat("x", 301)
	_, err = savedAssistantValuesFromRequest(savedAssistantRequest{
		Name:        &name,
		Description: &tooLong,
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "description") {
		t.Fatalf("expected description validation error, got %v", err)
	}
}

func TestSavedAssistantInstructions(t *testing.T) {
	assistant := &models.SavedAssistant{Name: "Research brief", Instructions: "Be source-aware."}
	got := savedAssistantInstructions(assistant)
	want := "You are the saved assistant named \"Research brief\". Follow these instructions for this conversation:\n\nBe source-aware."
	if got != want {
		t.Fatalf("unexpected instructions: %q", got)
	}
	if savedAssistantInstructions(nil) != "" {
		t.Fatal("nil assistant should not produce instructions")
	}
}
