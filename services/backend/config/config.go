package config

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
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
}

type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

func Load() Config {
	jwtSecret := []byte(getenv("JUSTAI_JWT_SECRET", "justai-local-development-secret-change-me"))
	encryptionKey := []byte(getenv("JUSTAI_ENCRYPTION_KEY", "justai-local-encryption-key-change-me"))
	encryptionSum := sha256.Sum256(encryptionKey)
	return Config{
		Port:            getenv("JUSTAI_PORT", "8080"),
		DatabaseURL:     os.Getenv("JUSTAI_DATABASE_URL"),
		JWTSecret:       jwtSecret,
		EncryptionKey:   encryptionSum[:],
		FrontendOrigins: splitCSV(getenv("JUSTAI_FRONTEND_ORIGINS", "http://localhost:3000")),
		OIDC: OIDCConfig{
			Issuer:       os.Getenv("JUSTAI_OIDC_ISSUER"),
			ClientID:     os.Getenv("JUSTAI_OIDC_CLIENT_ID"),
			ClientSecret: os.Getenv("JUSTAI_OIDC_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("JUSTAI_OIDC_REDIRECT_URL"),
		},
		MCPOAuthRedirectURL: getenv("JUSTAI_MCP_OAUTH_REDIRECT_URL", "http://localhost:8080/api/v1/mcp/oauth/callback"),
		AllowPrivate:        getenvBool("JUSTAI_ALLOW_PRIVATE_TARGETS", false),
		DevSeed:             getenvBool("JUSTAI_DEV_SEED", true),
	}
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

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func getenvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
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
