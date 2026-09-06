package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Claims struct {
	Email          string `json:"email"`
	PlatformAdmin  bool   `json:"platformAdmin"`
	SessionVersion int    `json:"sv,omitempty"`
	// SessionID is optional for backwards compatibility with tokens issued
	// before per-device sessions were introduced. New sessions always include
	// it and the middleware can revoke one device without invalidating every
	// session for the user.
	SessionID string `json:"sid,omitempty"`
	jwt.RegisteredClaims
}

type TokenManager struct {
	secret   []byte
	issuer   string
	audience string
	keyID    string
}

func NewTokenManager(secret []byte) *TokenManager {
	return NewTokenManagerWithOptions(secret, TokenOptions{
		Issuer:   "justai-backend",
		Audience: "justai-web",
		KeyID:    "v1",
	})
}

// TokenOptions controls the validation metadata carried by access tokens.
// Keeping these values explicit prevents a token minted for another service
// from being accepted merely because it was signed with the same secret.
type TokenOptions struct {
	Issuer   string
	Audience string
	KeyID    string
}

func NewTokenManagerWithOptions(secret []byte, options TokenOptions) *TokenManager {
	return &TokenManager{
		secret:   append([]byte(nil), secret...),
		issuer:   options.Issuer,
		audience: options.Audience,
		keyID:    options.KeyID,
	}
}

func (m *TokenManager) Issue(userID uuid.UUID, email string, platformAdmin bool, sessionVersions ...int) (string, error) {
	return m.IssueWithSession(userID, email, platformAdmin, "", sessionVersions...)
}

func (m *TokenManager) IssueWithSession(userID uuid.UUID, email string, platformAdmin bool, sessionID string, sessionVersions ...int) (string, error) {
	sessionVersion := 0
	if len(sessionVersions) > 0 {
		sessionVersion = sessionVersions[0]
	}
	now := time.Now()
	claims := Claims{
		Email:          email,
		PlatformAdmin:  platformAdmin,
		SessionVersion: sessionVersion,
		SessionID:      sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			Issuer:    m.issuer,
			Audience:  jwt.ClaimStrings{m.audience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(12 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if m.keyID != "" {
		token.Header["kid"] = m.keyID
	}
	return token.SignedString(m.secret)
}

func (m *TokenManager) Parse(value string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(value, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		if m.keyID != "" {
			keyID, ok := token.Header["kid"].(string)
			if !ok || keyID != m.keyID {
				return nil, fmt.Errorf("unexpected signing key")
			}
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	if m.issuer != "" && claims.Issuer != m.issuer {
		return nil, fmt.Errorf("unexpected token issuer")
	}
	if m.audience != "" {
		matchedAudience := false
		for _, audience := range claims.Audience {
			if audience == m.audience {
				matchedAudience = true
				break
			}
		}
		if !matchedAudience {
			return nil, fmt.Errorf("unexpected token audience")
		}
	}
	return claims, nil
}

func NewOpaqueToken() (value string, hash string, err error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", err
	}
	value = base64.RawURLEncoding.EncodeToString(bytes)
	sum := sha256.Sum256([]byte(value))
	return value, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}
