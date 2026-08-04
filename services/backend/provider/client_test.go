package provider

import (
	"context"
	"strings"
	"testing"
)

func TestMockChatStreams(t *testing.T) {
	var response strings.Builder
	err := StreamChat(context.Background(), Endpoint{ProviderType: "mock"}, ChatOptions{}, func(delta string) error {
		response.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(response.String(), "JustAI is ready") {
		t.Fatalf("unexpected mock response: %q", response.String())
	}
}
