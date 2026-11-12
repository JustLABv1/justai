package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

// 1x1 transparent PNG.
const testPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="

func TestPersistMCPResultImagesHandlesMarkdownDataURIAndImageBlock(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	imageID := uuid.New()
	for i := 0; i < 2; i++ {
		mock.ExpectQuery("INSERT INTO generated_images").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(imageID))
	}
	input, _ := json.Marshal(map[string]any{"content": []map[string]any{
		{"type": "text", "text": "![Image from source 1](data:image/png;base64," + testPNGBase64 + ")"},
		{"type": "image", "data": testPNGBase64, "mimeType": "image/png"},
	}})
	out := string((&App{DB: database}).persistMCPResultImages(context.Background(), uuid.New(), uuid.New(), "grafana", input))
	if strings.Contains(out, testPNGBase64) {
		t.Fatalf("base64 data leaked into result: %s", out)
	}
	if strings.Count(out, "/api/v1/images/"+imageID.String()) != 2 {
		t.Fatalf("expected two stored image references: %s", out)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistMCPResultImagesLeavesPlainResultsAlone(t *testing.T) {
	input := json.RawMessage(`{"content":[{"type":"text","text":"hello"}]}`)
	if out := (&App{}).persistMCPResultImages(context.Background(), uuid.New(), uuid.New(), "x", input); string(out) != string(input) {
		t.Fatalf("unexpected rewrite: %s", out)
	}
}
