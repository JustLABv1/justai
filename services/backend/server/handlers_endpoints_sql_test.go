package server

import (
	"context"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

func TestUpdateEndpointSQLTypesNullableCredential(t *testing.T) {
	want := "credential_ciphertext = CASE WHEN $16 THEN NULL ELSE COALESCE($17::bytea, credential_ciphertext) END"
	if !strings.Contains(updateEndpointSQL, want) {
		t.Fatalf("updateEndpointSQL does not type the nullable credential parameter: %s", want)
	}
}

func TestEnsureEndpointDefaultDoesNotPromoteReplacement(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Clearing a default must remain cleared. The only statement this helper
	// should issue is the legacy-invalid-marker cleanup, never a candidate
	// promotion query.
	mock.ExpectExec("UPDATE endpoint_settings").
		WithArgs("organization", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 0))
	scopeID := uuid.New()
	if err := ensureEndpointDefault(context.Background(), db, "organization", &scopeID); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
