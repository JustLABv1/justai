package server

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func encodeTimeUUIDCursor(at time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "." + id.String()))
}

func decodeTimeUUIDCursor(value string) (time.Time, uuid.UUID, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor")
	}
	raw := string(decoded)
	separator := strings.LastIndex(raw, ".")
	if separator <= 0 || separator == len(raw)-1 {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor")
	}
	at, err := time.Parse(time.RFC3339Nano, raw[:separator])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor")
	}
	id, err := uuid.Parse(raw[separator+1:])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor")
	}
	return at, id, nil
}
