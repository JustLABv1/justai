package server

import (
	"strings"
	"testing"
)

func TestUpdateEndpointSQLTypesNullableCredential(t *testing.T) {
	want := "credential_ciphertext = CASE WHEN $16 THEN NULL ELSE COALESCE($17::bytea, credential_ciphertext) END"
	if !strings.Contains(updateEndpointSQL, want) {
		t.Fatalf("updateEndpointSQL does not type the nullable credential parameter: %s", want)
	}
}
