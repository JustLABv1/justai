package server

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

func TestNormalizeMCPIconURL(t *testing.T) {
	valid := " https://cdn.example.test/icons/kairos.svg "
	tooLong := "https://example.test/" + string(make([]byte, 2049))
	tests := []struct {
		name    string
		raw     *string
		want    string
		wantErr bool
	}{
		{name: "unset", want: ""},
		{name: "blank", raw: stringPtr("  "), want: ""},
		{name: "http and https are supported", raw: &valid, want: "https://cdn.example.test/icons/kairos.svg"},
		{name: "relative URL", raw: stringPtr("/icons/kairos.svg"), wantErr: true},
		{name: "javascript URL", raw: stringPtr("javascript:alert(1)"), wantErr: true},
		{name: "userinfo is rejected", raw: stringPtr("https://user:pass@example.test/icon.svg"), wantErr: true},
		{name: "too long", raw: &tooLong, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeMCPIconURL(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("normalizeMCPIconURL() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("normalizeMCPIconURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNormalizeMCPServerIconOptimizesLargeJPEG(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 1200, 900))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			value := uint8((x*37 + y*53 + x*y) % 256)
			source.SetRGBA(x, y, color.RGBA{R: value, G: value ^ 0x55, B: value ^ 0xaa, A: 0xff})
		}
	}

	var input bytes.Buffer
	if err := jpeg.Encode(&input, source, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	if input.Len() <= maxMCPServerIconStoredBytes {
		t.Fatalf("test JPEG should exceed the stored icon limit, got %d bytes", input.Len())
	}

	optimized, mimeType, err := normalizeMCPServerIcon(input.Bytes(), "image/jpeg")
	if err != nil {
		t.Fatalf("normalizeMCPServerIcon() error = %v", err)
	}
	if mimeType != "image/png" {
		t.Fatalf("normalized MIME type = %q, want image/png", mimeType)
	}
	if len(optimized) > maxMCPServerIconStoredBytes {
		t.Fatalf("normalized icon is %d bytes, want at most %d", len(optimized), maxMCPServerIconStoredBytes)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(optimized))
	if err != nil {
		t.Fatalf("normalized icon is not a valid image: %v", err)
	}
	if config.Width > maxMCPServerIconDimension || config.Height > maxMCPServerIconDimension {
		t.Fatalf("normalized dimensions = %dx%d, want at most %dpx", config.Width, config.Height, maxMCPServerIconDimension)
	}
}

func TestNormalizeMCPServerIconPreservesSmallPNG(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 16, 16))
	var input bytes.Buffer
	if err := png.Encode(&input, source); err != nil {
		t.Fatal(err)
	}

	optimized, mimeType, err := normalizeMCPServerIcon(input.Bytes(), "image/png")
	if err != nil {
		t.Fatalf("normalizeMCPServerIcon() error = %v", err)
	}
	if mimeType != "image/png" {
		t.Fatalf("MIME type = %q, want image/png", mimeType)
	}
	if !bytes.Equal(optimized, input.Bytes()) {
		t.Fatal("small PNG should not be re-encoded")
	}
}

func stringPtr(value string) *string {
	return &value
}

func TestLoadMCPServerAllowsUnsetOAuthTokenURL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	serverID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, endpoint_url, auth_type, encrypted_credential, oauth_refresh_credential, COALESCE(oauth_token_url, ''), COALESCE(oauth_client_id, ''), oauth_expires_at, allowed_tools, trusted_read_only, COALESCE(protocol_version, '') FROM mcp_servers WHERE id = $1 AND enabled = TRUE")).
		WithArgs(serverID).
		WillReturnRows(sqlmock.NewRows([]string{
			"id",
			"endpoint_url",
			"auth_type",
			"encrypted_credential",
			"oauth_refresh_credential",
			"oauth_token_url",
			"oauth_client_id",
			"oauth_expires_at",
			"allowed_tools",
			"trusted_read_only",
			"protocol_version",
		}).AddRow(
			serverID,
			"https://mcp.example.test/sse",
			"none",
			nil,
			nil,
			"",
			"",
			nil,
			[]byte("[]"),
			false,
			"",
		))

	app := &App{DB: db}
	loaded, err := app.loadMCPServer(context.Background(), serverID.String())
	if err != nil {
		t.Fatalf("expected a NULL OAuth token URL to load as empty, got: %v", err)
	}
	if loaded.ID != serverID.String() || loaded.OAuthTokenURL != "" {
		t.Fatalf("unexpected loaded MCP server: %+v", loaded)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
