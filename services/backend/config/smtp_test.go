package config

import "testing"

func TestValidateSMTP(t *testing.T) {
	good := SMTPConfig{Host: "smtp.server.example", Port: 587, From: "JustAI <justai@example.org>", Security: "starttls"}
	if err := ValidateSMTP(good); err != nil {
		t.Fatalf("valid setup rejected: %v", err)
	}
	for name, change := range map[string]func(*SMTPConfig){
		"empty host":       func(c *SMTPConfig) { c.Host = "" },
		"host with space":  func(c *SMTPConfig) { c.Host = "smtp example" },
		"host with CRLF":   func(c *SMTPConfig) { c.Host = "smtp.example\r\nX: y" },
		"port zero":        func(c *SMTPConfig) { c.Port = 0 },
		"unknown security": func(c *SMTPConfig) { c.Security = "ssl" },
		"bad sender":       func(c *SMTPConfig) { c.From = "not an address" },
	} {
		bad := good
		change(&bad)
		if ValidateSMTP(bad) == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
