package config

import "testing"

func TestMeetingBotConfigIsOptionalAndValidated(t *testing.T) {
	t.Setenv("JUSTAI_MEETING_BOT_URL", "")
	t.Setenv("JUSTAI_MEETING_BOT_TOKEN", "")
	disabled, err := meetingBotConfig(fileMeetingBotConfig{})
	if err != nil || disabled.URL != "" {
		t.Fatalf("an unset meeting bot must simply be disabled: %+v, %v", disabled, err)
	}
	enabled, err := meetingBotConfig(fileMeetingBotConfig{URL: "http://meeting-bot:8091/", Token: "bot-service-token-0123"})
	if err != nil || enabled.URL != "http://meeting-bot:8091" {
		t.Fatalf("expected a trimmed URL, got %+v, %v", enabled, err)
	}
	for name, values := range map[string]fileMeetingBotConfig{
		"not a url":    {URL: "meeting-bot:8091", Token: "bot-service-token-0123"},
		"wrong scheme": {URL: "ftp://meeting-bot", Token: "bot-service-token-0123"},
		"short token":  {URL: "http://meeting-bot:8091", Token: "short"},
	} {
		if _, err := meetingBotConfig(values); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	t.Setenv("JUSTAI_MEETING_BOT_URL", "http://from-env:8091")
	t.Setenv("JUSTAI_MEETING_BOT_TOKEN", "env-token-0123456789")
	fromEnv, err := meetingBotConfig(fileMeetingBotConfig{URL: "http://from-file:1", Token: "file-token-0123456789"})
	if err != nil || fromEnv.URL != "http://from-env:8091" || fromEnv.Token != "env-token-0123456789" {
		t.Fatalf("environment must win over the file: %+v, %v", fromEnv, err)
	}
}
