package provider

import (
	"context"
	"encoding/json"
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

func TestOpenAIMessageContentIncludesImageParts(t *testing.T) {
	content := openAIMessageContent(Message{
		Content: "What is this?",
		ContentParts: []MessageContentPart{{
			Type:     "image_url",
			ImageURL: &MessageImageURL{URL: "data:image/png;base64,aGVsbG8=", Detail: "auto"},
		}},
	})
	encoded, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	var parts []map[string]any
	if err := json.Unmarshal(encoded, &parts); err != nil {
		t.Fatal(err)
	}
	if len(parts) != 2 || parts[0]["type"] != "text" || parts[0]["text"] != "What is this?" || parts[1]["type"] != "image_url" {
		t.Fatalf("unexpected OpenAI content: %s", encoded)
	}
	image, ok := parts[1]["image_url"].(map[string]any)
	if !ok || image["url"] != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("unexpected image part: %+v", parts[1])
	}
}
