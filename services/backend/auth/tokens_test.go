package auth

import (
	"testing"

	"github.com/google/uuid"
)

func TestTokenRoundTripIncludesSessionVersion(t *testing.T) {
	manager := NewTokenManager([]byte("test-secret"))
	userID := uuid.New()
	token, err := manager.Issue(userID, "admin@example.com", true, 7)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	claims, err := manager.Parse(token)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	if claims.Subject != userID.String() || claims.Email != "admin@example.com" || !claims.PlatformAdmin || claims.SessionVersion != 7 {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}
