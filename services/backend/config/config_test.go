package config

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFromYAML(t *testing.T) {
	clearConfigEnv(t)
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	configYAML := `
port: "9090"
database_url: "postgres://from-file"
jwt_secret: "file-jwt-secret"
encryption_key: "file-encryption-key"
frontend_origins:
  - "http://localhost:3000"
  - "http://localhost:3001"
oidc:
  issuer: "https://issuer.example.com"
  client_id: "client-from-file"
  client_secret: "secret-from-file"
  redirect_url: "http://localhost:8080/callback"
mcp_oauth_redirect_url: "http://localhost:8080/mcp/callback"
allow_private_targets: true
dev_seed: false
`
	if err := os.WriteFile(configPath, []byte(configYAML), 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(configPath)
	if err != nil {
		t.Fatal(err)
	}

	if loaded.Port != "9090" || loaded.DatabaseURL != "postgres://from-file" {
		t.Fatalf("unexpected server config: %+v", loaded)
	}
	if string(loaded.JWTSecret) != "file-jwt-secret" {
		t.Fatalf("unexpected JWT secret: %q", loaded.JWTSecret)
	}
	keySum := sha256.Sum256([]byte("file-encryption-key"))
	if string(loaded.EncryptionKey) != string(keySum[:]) {
		t.Fatal("encryption key was not derived from the YAML value")
	}
	if len(loaded.FrontendOrigins) != 2 || loaded.FrontendOrigins[1] != "http://localhost:3001" {
		t.Fatalf("unexpected frontend origins: %#v", loaded.FrontendOrigins)
	}
	if !loaded.AllowPrivate || loaded.DevSeed || !loaded.OIDCEnabled() {
		t.Fatalf("unexpected feature config: %+v", loaded)
	}
	if loaded.RepositoryMaxFiles != 200 {
		t.Fatalf("unexpected repository file limit: %d", loaded.RepositoryMaxFiles)
	}
	if loaded.Transcription.StreamingChunkMs != 2500 || loaded.Transcription.StreamingOverlapMs != 500 || loaded.Transcription.StreamingPromptChars != 160 {
		t.Fatalf("unexpected streaming transcription defaults: %+v", loaded.Transcription)
	}
	if loaded.Transcription.VideoUploadMaxBytes != 5*1024*1024*1024 || loaded.Transcription.VideoUploadPartBytes != 16*1024*1024 || loaded.Transcription.VideoMaxDurationHours != 4 {
		t.Fatalf("unexpected video transcription defaults: %+v", loaded.Transcription)
	}
}

func TestEnvironmentOverridesYAML(t *testing.T) {
	clearConfigEnv(t)
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte("port: \"9090\"\ndatabase_url: \"postgres://from-file\"\ndev_seed: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JUSTAI_PORT", "9191")
	t.Setenv("JUSTAI_DATABASE_URL", "postgres://from-env")
	t.Setenv("JUSTAI_DEV_SEED", "false")
	t.Setenv("JUSTAI_TRANSCRIPTION_S3_PROCESSING_ENDPOINT", "http://host.containers.internal:9000")
	t.Setenv("JUSTAI_REPOSITORY_MAX_FILES", "1000")

	loaded, err := Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Port != "9191" || loaded.DatabaseURL != "postgres://from-env" || loaded.DevSeed {
		t.Fatalf("environment values did not override YAML: %+v", loaded)
	}
	if loaded.RepositoryMaxFiles != 1000 {
		t.Fatalf("repository file limit did not load from the environment: %d", loaded.RepositoryMaxFiles)
	}
	if loaded.Transcription.S3ProcessingEndpoint != "http://host.containers.internal:9000" {
		t.Fatalf("S3 processing endpoint did not load from the environment: %q", loaded.Transcription.S3ProcessingEndpoint)
	}
}

func TestLoadReturnsConfigFileErrors(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("expected a missing config file error")
	}
}

func TestProductionRejectsDevelopmentSecrets(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("JUSTAI_ENV", "production")
	t.Setenv("JUSTAI_DATABASE_URL", "postgres://justai")
	t.Setenv("JUSTAI_JWT_SECRET", "replace-with-a-long-development-secret-value")
	t.Setenv("JUSTAI_ENCRYPTION_KEY", "replace-with-a-long-development-encryption-key")
	t.Setenv("JUSTAI_MCP_OAUTH_REDIRECT_URL", "https://app.example.com/api/v1/mcp/oauth/callback")
	if _, err := Load(""); err == nil {
		t.Fatal("expected development secrets to be rejected in production")
	}
}

func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"JUSTAI_ENV",
		"JUSTAI_PORT",
		"JUSTAI_DATABASE_URL",
		"JUSTAI_JWT_SECRET",
		"JUSTAI_ENCRYPTION_KEY",
		"JUSTAI_FRONTEND_ORIGINS",
		"JUSTAI_OIDC_ISSUER",
		"JUSTAI_OIDC_CLIENT_ID",
		"JUSTAI_OIDC_CLIENT_SECRET",
		"JUSTAI_OIDC_REDIRECT_URL",
		"JUSTAI_MCP_OAUTH_REDIRECT_URL",
		"JUSTAI_ALLOW_PRIVATE_TARGETS",
		"JUSTAI_DEV_SEED",
		"JUSTAI_SECURE_COOKIES",
		"JUSTAI_COOKIE_SAMESITE",
		"JUSTAI_COOKIE_DOMAIN",
		"JUSTAI_REPOSITORY_MAX_FILES",
		"JUSTAI_TRANSCRIPTION_VIDEO_UPLOAD_MAX_BYTES",
		"JUSTAI_TRANSCRIPTION_VIDEO_UPLOAD_PART_BYTES",
		"JUSTAI_TRANSCRIPTION_VIDEO_MAX_DURATION_HOURS",
		"JUSTAI_TRANSCRIPTION_S3_PROCESSING_ENDPOINT",
	} {
		t.Setenv(key, "")
	}
}
