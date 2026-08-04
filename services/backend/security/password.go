package security

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

func HashPassword(password string) (string, error) {
	if len(password) < 8 {
		return "", fmt.Errorf("password must be at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	return fmt.Sprintf("argon2id$v=19$m=65536,t=1,p=4$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash)), nil
}

func CheckPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" || parts[1] != "v=19" || parts[2] != "m=65536,t=1,p=4" {
		return false
	}
	saltEncoded, hashEncoded := parts[3], parts[4]
	salt, err := base64.RawStdEncoding.DecodeString(saltEncoded)
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(hashEncoded)
	if err != nil {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, uint32(len(expected)))
	if len(actual) != len(expected) {
		return false
	}
	var result byte
	for index := range actual {
		result |= actual[index] ^ expected[index]
	}
	return result == 0
}
