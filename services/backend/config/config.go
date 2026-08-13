package config

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/goccy/go-yaml"
)

type Config struct {
	Port                string
	DatabaseURL         string
	JWTSecret           []byte
	EncryptionKey       []byte
	FrontendOrigins     []string
	OIDC                OIDCConfig
	MCPOAuthRedirectURL string
	AllowPrivate        bool
	DevSeed             bool
	SecureCookies       bool
	CookieSameSite      string
	CookieDomain        string
	Transcription       TranscriptionConfig
}

type TranscriptionConfig struct {
	StorageDriver        string
	LocalStoragePath     string
	S3Endpoint           string
	S3Region             string
	S3Bucket             string
	S3AccessKey          string
	S3SecretKey          string
	AudioRetentionDays   int
	DiarizationWindow    int
	DiarizationOverlap   int
	StreamingChunkMs     int
	StreamingOverlapMs   int
	StreamingPromptChars int
	MaxSessionHours      int
}

type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

type fileConfig struct {
	Port                string                  `yaml:"port"`
	DatabaseURL         string                  `yaml:"database_url"`
	JWTSecret           string                  `yaml:"jwt_secret"`
	EncryptionKey       string                  `yaml:"encryption_key"`
	FrontendOrigins     []string                `yaml:"frontend_origins"`
	OIDC                fileOIDCConfig          `yaml:"oidc"`
	MCPOAuthRedirectURL string                  `yaml:"mcp_oauth_redirect_url"`
	AllowPrivate        *bool                   `yaml:"allow_private_targets"`
	DevSeed             *bool                   `yaml:"dev_seed"`
	SecureCookies       *bool                   `yaml:"secure_cookies"`
	CookieSameSite      string                  `yaml:"cookie_same_site"`
	CookieDomain        string                  `yaml:"cookie_domain"`
	Transcription       fileTranscriptionConfig `yaml:"transcription"`
}

type fileTranscriptionConfig struct {
	StorageDriver        string `yaml:"storage_driver"`
	LocalStoragePath     string `yaml:"local_storage_path"`
	S3Endpoint           string `yaml:"s3_endpoint"`
	S3Region             string `yaml:"s3_region"`
	S3Bucket             string `yaml:"s3_bucket"`
	S3AccessKey          string `yaml:"s3_access_key"`
	S3SecretKey          string `yaml:"s3_secret_key"`
	AudioRetentionDays   int    `yaml:"audio_retention_days"`
	DiarizationWindow    int    `yaml:"diarization_window_seconds"`
	DiarizationOverlap   int    `yaml:"diarization_overlap_seconds"`
	StreamingChunkMs     int    `yaml:"streaming_chunk_ms"`
	StreamingOverlapMs   int    `yaml:"streaming_overlap_ms"`
	StreamingPromptChars int    `yaml:"streaming_prompt_chars"`
	MaxSessionHours      int    `yaml:"max_session_hours"`
}

type fileOIDCConfig struct {
	Issuer       string `yaml:"issuer"`
	ClientID     string `yaml:"client_id"`
	ClientSecret string `yaml:"client_secret"`
	RedirectURL  string `yaml:"redirect_url"`
}

func Load(configPath string) (Config, error) {
	fileValues, err := readFileConfig(configPath)
	if err != nil {
		return Config{}, err
	}

	environment := strings.ToLower(strings.TrimSpace(os.Getenv("JUSTAI_ENV")))
	isProduction := environment == "production" || environment == "prod"
	jwtValue := getenvOrFile("JUSTAI_JWT_SECRET", fileValues.JWTSecret, "justai-local-development-secret-change-me")
	encryptionValue := getenvOrFile("JUSTAI_ENCRYPTION_KEY", fileValues.EncryptionKey, "justai-local-encryption-key-change-me")
	if isProduction {
		if isDevelopmentSecret(jwtValue) || len(jwtValue) < 32 {
			return Config{}, fmt.Errorf("JUSTAI_JWT_SECRET must be a unique secret of at least 32 characters in production")
		}
		if isDevelopmentSecret(encryptionValue) || len(encryptionValue) < 16 {
			return Config{}, fmt.Errorf("JUSTAI_ENCRYPTION_KEY must be a unique secret in production")
		}
	}
	jwtSecret := []byte(jwtValue)
	encryptionKey := []byte(encryptionValue)
	encryptionSum := sha256.Sum256(encryptionKey)
	secureCookies := getenvBoolOrFile("JUSTAI_SECURE_COOKIES", fileValues.SecureCookies, isProduction)
	cookieSameSite := strings.ToLower(strings.TrimSpace(getenvOrFile("JUSTAI_COOKIE_SAMESITE", fileValues.CookieSameSite, "lax")))
	if cookieSameSite != "lax" && cookieSameSite != "strict" && cookieSameSite != "none" {
		return Config{}, fmt.Errorf("JUSTAI_COOKIE_SAMESITE must be lax, strict, or none")
	}
	if cookieSameSite == "none" && !secureCookies {
		return Config{}, fmt.Errorf("SameSite=None cookies require secure cookies")
	}
	devSeed := getenvBoolOrFile("JUSTAI_DEV_SEED", fileValues.DevSeed, !isProduction)
	if isProduction && devSeed {
		return Config{}, fmt.Errorf("JUSTAI_DEV_SEED must be false in production")
	}
	if isProduction && !secureCookies {
		return Config{}, fmt.Errorf("JUSTAI_SECURE_COOKIES must be true in production")
	}
	mcpOAuthRedirectURL := getenvOrFile("JUSTAI_MCP_OAUTH_REDIRECT_URL", fileValues.MCPOAuthRedirectURL, "http://localhost:8080/api/v1/mcp/oauth/callback")
	if parsed, err := url.Parse(mcpOAuthRedirectURL); err != nil || parsed.Scheme == "" || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return Config{}, fmt.Errorf("JUSTAI_MCP_OAUTH_REDIRECT_URL must be an absolute http(s) URL")
	}
	if isProduction && mcpOAuthRedirectURL == "http://localhost:8080/api/v1/mcp/oauth/callback" {
		return Config{}, fmt.Errorf("JUSTAI_MCP_OAUTH_REDIRECT_URL must be configured in production")
	}
	return Config{
		Port:            getenvOrFile("JUSTAI_PORT", fileValues.Port, "8080"),
		DatabaseURL:     getenvOrFile("JUSTAI_DATABASE_URL", fileValues.DatabaseURL, ""),
		JWTSecret:       jwtSecret,
		EncryptionKey:   encryptionSum[:],
		FrontendOrigins: frontendOrigins(fileValues.FrontendOrigins),
		OIDC: OIDCConfig{
			Issuer:       getenvOrFile("JUSTAI_OIDC_ISSUER", fileValues.OIDC.Issuer, ""),
			ClientID:     getenvOrFile("JUSTAI_OIDC_CLIENT_ID", fileValues.OIDC.ClientID, ""),
			ClientSecret: getenvOrFile("JUSTAI_OIDC_CLIENT_SECRET", fileValues.OIDC.ClientSecret, ""),
			RedirectURL:  getenvOrFile("JUSTAI_OIDC_REDIRECT_URL", fileValues.OIDC.RedirectURL, ""),
		},
		MCPOAuthRedirectURL: mcpOAuthRedirectURL,
		AllowPrivate:        getenvBoolOrFile("JUSTAI_ALLOW_PRIVATE_TARGETS", fileValues.AllowPrivate, false),
		DevSeed:             devSeed,
		SecureCookies:       secureCookies,
		CookieSameSite:      cookieSameSite,
		CookieDomain:        getenvOrFile("JUSTAI_COOKIE_DOMAIN", fileValues.CookieDomain, ""),
		Transcription:       transcriptionConfig(fileValues.Transcription),
	}, nil
}

func transcriptionConfig(values fileTranscriptionConfig) TranscriptionConfig {
	result := TranscriptionConfig{
		StorageDriver:        getenvOrFile("JUSTAI_TRANSCRIPTION_STORAGE_DRIVER", values.StorageDriver, "local"),
		LocalStoragePath:     getenvOrFile("JUSTAI_TRANSCRIPTION_LOCAL_STORAGE_PATH", values.LocalStoragePath, "./data/transcription"),
		S3Endpoint:           getenvOrFile("JUSTAI_TRANSCRIPTION_S3_ENDPOINT", values.S3Endpoint, ""),
		S3Region:             getenvOrFile("JUSTAI_TRANSCRIPTION_S3_REGION", values.S3Region, "us-east-1"),
		S3Bucket:             getenvOrFile("JUSTAI_TRANSCRIPTION_S3_BUCKET", values.S3Bucket, ""),
		S3AccessKey:          getenvOrFile("JUSTAI_TRANSCRIPTION_S3_ACCESS_KEY", values.S3AccessKey, ""),
		S3SecretKey:          getenvOrFile("JUSTAI_TRANSCRIPTION_S3_SECRET_KEY", values.S3SecretKey, ""),
		AudioRetentionDays:   values.AudioRetentionDays,
		DiarizationWindow:    values.DiarizationWindow,
		DiarizationOverlap:   values.DiarizationOverlap,
		StreamingChunkMs:     values.StreamingChunkMs,
		StreamingOverlapMs:   values.StreamingOverlapMs,
		StreamingPromptChars: values.StreamingPromptChars,
		MaxSessionHours:      values.MaxSessionHours,
	}
	if result.AudioRetentionDays <= 0 {
		result.AudioRetentionDays = 30
	}
	if result.DiarizationWindow <= 0 {
		result.DiarizationWindow = 30
	}
	if result.DiarizationOverlap <= 0 || result.DiarizationOverlap >= result.DiarizationWindow {
		result.DiarizationOverlap = 5
	}
	if result.StreamingChunkMs <= 0 {
		result.StreamingChunkMs = 2500
	}
	if result.StreamingOverlapMs <= 0 || result.StreamingOverlapMs >= result.StreamingChunkMs {
		result.StreamingOverlapMs = 500
	}
	if result.StreamingPromptChars <= 0 {
		result.StreamingPromptChars = 160
	}
	if result.MaxSessionHours <= 0 {
		result.MaxSessionHours = 8
	}
	if result.StorageDriver != "s3" {
		result.StorageDriver = "local"
	}
	return result
}

func readFileConfig(configPath string) (fileConfig, error) {
	if strings.TrimSpace(configPath) == "" {
		return fileConfig{}, nil
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return fileConfig{}, fmt.Errorf("read config file %q: %w", configPath, err)
	}
	var values fileConfig
	if err := yaml.Unmarshal(data, &values); err != nil {
		return fileConfig{}, fmt.Errorf("parse config file %q: %w", configPath, err)
	}
	return values, nil
}

func frontendOrigins(fileValues []string) []string {
	if value := strings.TrimSpace(os.Getenv("JUSTAI_FRONTEND_ORIGINS")); value != "" {
		return splitCSV(value)
	}
	if len(fileValues) > 0 {
		return append([]string(nil), fileValues...)
	}
	return []string{"http://localhost:3000"}
}

func (c Config) OIDCEnabled() bool {
	return c.OIDC.Issuer != "" && c.OIDC.ClientID != "" && c.OIDC.ClientSecret != "" && c.OIDC.RedirectURL != ""
}

func (c Config) Address() string {
	if strings.HasPrefix(c.Port, ":") {
		return c.Port
	}
	return fmt.Sprintf(":%s", c.Port)
}

func getenvOrFile(key, fileValue, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	if value := strings.TrimSpace(fileValue); value != "" {
		return value
	}
	return fallback
}

func getenvBoolOrFile(key string, fileValue *bool, fallback bool) bool {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err == nil {
			return parsed
		}
		return fallback
	}
	if fileValue != nil {
		return *fileValue
	}
	return fallback
}

func isDevelopmentSecret(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	for _, marker := range []string{"justai-local", "change-me", "replace-with", "development", "dev-secret", "test-secret"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func BasicAuthHeader(value string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(value))
}
