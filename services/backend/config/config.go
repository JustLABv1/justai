package config

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
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
	Transcription       TranscriptionConfig
}

type TranscriptionConfig struct {
	StorageDriver      string
	LocalStoragePath   string
	S3Endpoint         string
	S3Region           string
	S3Bucket           string
	S3AccessKey        string
	S3SecretKey        string
	AudioRetentionDays int
	DiarizationWindow  int
	DiarizationOverlap int
	MaxSessionHours    int
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
	Transcription       fileTranscriptionConfig `yaml:"transcription"`
}

type fileTranscriptionConfig struct {
	StorageDriver      string `yaml:"storage_driver"`
	LocalStoragePath   string `yaml:"local_storage_path"`
	S3Endpoint         string `yaml:"s3_endpoint"`
	S3Region           string `yaml:"s3_region"`
	S3Bucket           string `yaml:"s3_bucket"`
	S3AccessKey        string `yaml:"s3_access_key"`
	S3SecretKey        string `yaml:"s3_secret_key"`
	AudioRetentionDays int    `yaml:"audio_retention_days"`
	DiarizationWindow  int    `yaml:"diarization_window_seconds"`
	DiarizationOverlap int    `yaml:"diarization_overlap_seconds"`
	MaxSessionHours    int    `yaml:"max_session_hours"`
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

	jwtSecret := []byte(getenvOrFile("JUSTAI_JWT_SECRET", fileValues.JWTSecret, "justai-local-development-secret-change-me"))
	encryptionKey := []byte(getenvOrFile("JUSTAI_ENCRYPTION_KEY", fileValues.EncryptionKey, "justai-local-encryption-key-change-me"))
	encryptionSum := sha256.Sum256(encryptionKey)
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
		MCPOAuthRedirectURL: getenvOrFile("JUSTAI_MCP_OAUTH_REDIRECT_URL", fileValues.MCPOAuthRedirectURL, "http://localhost:8080/api/v1/mcp/oauth/callback"),
		AllowPrivate:        getenvBoolOrFile("JUSTAI_ALLOW_PRIVATE_TARGETS", fileValues.AllowPrivate, false),
		DevSeed:             getenvBoolOrFile("JUSTAI_DEV_SEED", fileValues.DevSeed, true),
		Transcription:       transcriptionConfig(fileValues.Transcription),
	}, nil
}

func transcriptionConfig(values fileTranscriptionConfig) TranscriptionConfig {
	result := TranscriptionConfig{
		StorageDriver:      getenvOrFile("JUSTAI_TRANSCRIPTION_STORAGE_DRIVER", values.StorageDriver, "local"),
		LocalStoragePath:   getenvOrFile("JUSTAI_TRANSCRIPTION_LOCAL_STORAGE_PATH", values.LocalStoragePath, "./data/transcription"),
		S3Endpoint:         getenvOrFile("JUSTAI_TRANSCRIPTION_S3_ENDPOINT", values.S3Endpoint, ""),
		S3Region:           getenvOrFile("JUSTAI_TRANSCRIPTION_S3_REGION", values.S3Region, "us-east-1"),
		S3Bucket:           getenvOrFile("JUSTAI_TRANSCRIPTION_S3_BUCKET", values.S3Bucket, ""),
		S3AccessKey:        getenvOrFile("JUSTAI_TRANSCRIPTION_S3_ACCESS_KEY", values.S3AccessKey, ""),
		S3SecretKey:        getenvOrFile("JUSTAI_TRANSCRIPTION_S3_SECRET_KEY", values.S3SecretKey, ""),
		AudioRetentionDays: values.AudioRetentionDays,
		DiarizationWindow:  values.DiarizationWindow,
		DiarizationOverlap: values.DiarizationOverlap,
		MaxSessionHours:    values.MaxSessionHours,
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
