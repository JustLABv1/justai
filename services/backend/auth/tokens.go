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
	Email         string `json:"email"`
	PlatformAdmin bool   `json:"platformAdmin"`
	jwt.RegisteredClaims
}

type TokenManager struct {
	secret []byte
}

func NewTokenManager(secret []byte) *TokenManager {
	return &TokenManager{secret: append([]byte(nil), secret...)}
}

func (m *TokenManager) Issue(userID uuid.UUID, email string, platformAdmin bool) (string, error) {
	now := time.Now()
	claims := Claims{
		Email:         email,
		PlatformAdmin: platformAdmin,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(12 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(m.secret)
}

func (m *TokenManager) Parse(value string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(value, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
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
