package server

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// backupObject is one stored file referenced by the database, such as a
// recording part or an uploaded video. Keys are relative to the storage root
// and always use forward slashes.
type backupObject struct {
	Key  string
	Size int64
}

// backupFileStore reads and writes the binary objects that live outside
// Postgres. Recordings remember the driver they were written with, so a
// backup keeps objects grouped by driver and restores them into the same one.
type backupFileStore interface {
	Driver() string
	List(ctx context.Context, visit func(backupObject) error) error
	Open(ctx context.Context, key string) (io.ReadCloser, error)
	Write(ctx context.Context, key string, body io.Reader, size int64) error
}

const (
	backupDriverLocal = "local"
	backupDriverS3    = "s3"
)

// backupFileStores returns every configured object store. Local storage is
// always available; S3 is included when credentials are configured, even if
// the current default driver is local, because older recordings may still
// point at it.
func (a *App) backupFileStores() map[string]backupFileStore {
	stores := map[string]backupFileStore{
		backupDriverLocal: localBackupStore{root: a.Config.Transcription.LocalStoragePath, skipDir: a.backupStagingDir()},
	}
	if storage, err := newS3Storage(a.Config); err == nil {
		stores[backupDriverS3] = s3BackupStore{storage: storage}
	}
	return stores
}

// cleanBackupKey rejects keys that could escape the storage root when they
// come from an uploaded archive.
func cleanBackupKey(key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") || strings.ContainsRune(key, 0) {
		return "", fmt.Errorf("invalid object key %q", key)
	}
	cleaned := path.Clean(key)
	if cleaned != key || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("invalid object key %q", key)
	}
	return cleaned, nil
}

type localBackupStore struct {
	root string
	// skipDir keeps staged backup uploads out of an export when the staging
	// directory was configured inside the local storage root.
	skipDir string
}

func (s localBackupStore) Driver() string { return backupDriverLocal }

func (s localBackupStore) List(ctx context.Context, visit func(backupObject) error) error {
	if strings.TrimSpace(s.root) == "" {
		return nil
	}
	if _, err := os.Stat(s.root); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return filepath.WalkDir(s.root, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if entry.IsDir() {
			if s.skipDir != "" && sameFilePath(current, s.skipDir) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".restore-") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(s.root, current)
		if err != nil {
			return err
		}
		return visit(backupObject{Key: filepath.ToSlash(relative), Size: info.Size()})
	})
}

func sameFilePath(left, right string) bool {
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	return leftErr == nil && rightErr == nil && leftAbs == rightAbs
}

func (s localBackupStore) path(key string) (string, error) {
	cleaned, err := cleanBackupKey(key)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.root, filepath.FromSlash(cleaned)), nil
}

func (s localBackupStore) Open(_ context.Context, key string) (io.ReadCloser, error) {
	target, err := s.path(key)
	if err != nil {
		return nil, err
	}
	return os.Open(target)
}

func (s localBackupStore) Write(_ context.Context, key string, body io.Reader, _ int64) error {
	target, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	// Write next to the target and rename so an interrupted restore never
	// leaves a truncated object that looks complete.
	temporary, err := os.CreateTemp(filepath.Dir(target), ".restore-*")
	if err != nil {
		return err
	}
	if _, err := io.Copy(temporary, body); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporary.Name())
		return err
	}
	if err := os.Chmod(temporary.Name(), 0o600); err != nil {
		_ = os.Remove(temporary.Name())
		return err
	}
	return os.Rename(temporary.Name(), target)
}

type s3BackupStore struct {
	storage *s3Storage
}

func (s s3BackupStore) Driver() string { return backupDriverS3 }

func (s s3BackupStore) List(ctx context.Context, visit func(backupObject) error) error {
	continuation := ""
	for {
		query := url.Values{"list-type": {"2"}, "max-keys": {"1000"}}
		if continuation != "" {
			query.Set("continuation-token", continuation)
		}
		response, err := s.storage.request(ctx, http.MethodGet, "", query, nil, "")
		if err != nil {
			return err
		}
		if response.StatusCode >= http.StatusMultipleChoices {
			err := s3ErrorFromResponse(response)
			_ = response.Body.Close()
			return err
		}
		var result struct {
			IsTruncated           bool   `xml:"IsTruncated"`
			NextContinuationToken string `xml:"NextContinuationToken"`
			Contents              []struct {
				Key  string `xml:"Key"`
				Size int64  `xml:"Size"`
			} `xml:"Contents"`
		}
		decodeErr := xml.NewDecoder(response.Body).Decode(&result)
		_ = response.Body.Close()
		if decodeErr != nil {
			return decodeErr
		}
		for _, item := range result.Contents {
			if strings.HasSuffix(item.Key, "/") && item.Size == 0 {
				continue // folder placeholder created by some S3 consoles
			}
			if err := visit(backupObject{Key: item.Key, Size: item.Size}); err != nil {
				return err
			}
		}
		if !result.IsTruncated || result.NextContinuationToken == "" {
			return nil
		}
		continuation = result.NextContinuationToken
	}
}

func (s s3BackupStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	return s.storage.get(ctx, key)
}

// backupS3PartBytes keeps single PUTs well below the 5 GiB S3 limit while
// streaming large videos without buffering them in memory.
const backupS3PartBytes int64 = 64 * 1024 * 1024

func (s s3BackupStore) Write(ctx context.Context, key string, body io.Reader, size int64) error {
	if _, err := cleanBackupKey(key); err != nil {
		return err
	}
	const contentType = "application/octet-stream"
	if size <= backupS3PartBytes {
		response, err := s.storage.requestReader(ctx, http.MethodPut, key, nil, body, size, contentType, "UNSIGNED-PAYLOAD")
		if err != nil {
			return err
		}
		defer response.Body.Close()
		return readS3Response(response)
	}
	uploadID, err := s.storage.initiateMultipart(ctx, key, contentType)
	if err != nil {
		return err
	}
	parts := make([]s3MultipartPart, 0, size/backupS3PartBytes+1)
	remaining := size
	for partNumber := 1; remaining > 0; partNumber++ {
		length := min(remaining, backupS3PartBytes)
		result, err := s.storage.uploadMultipartPart(ctx, key, uploadID, partNumber, io.LimitReader(body, length), length, contentType)
		if err != nil {
			_ = s.storage.abortMultipart(context.WithoutCancel(ctx), key, uploadID)
			return err
		}
		parts = append(parts, s3MultipartPart{PartNumber: result.PartNumber, ETag: result.ETag})
		remaining -= length
	}
	if err := s.storage.completeMultipart(ctx, key, uploadID, parts); err != nil {
		_ = s.storage.abortMultipart(context.WithoutCancel(ctx), key, uploadID)
		return err
	}
	return nil
}
