package server

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCleanBackupKeyRejectsEscapes(t *testing.T) {
	for _, key := range []string{"", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", `a\b`, "a/\x00"} {
		if _, err := cleanBackupKey(key); err == nil {
			t.Errorf("key %q was accepted", key)
		}
	}
	for _, key := range []string{"transcription/abc/part-00000001", "video.mp4", "a/b..c"} {
		if _, err := cleanBackupKey(key); err != nil {
			t.Errorf("key %q was rejected: %v", key, err)
		}
	}
}

func TestSplitBackupFileEntry(t *testing.T) {
	driver, key, err := splitBackupFileEntry("files/s3/transcription/a/part-1")
	if err != nil || driver != "s3" || key != "transcription/a/part-1" {
		t.Fatalf("got %q %q %v", driver, key, err)
	}
	for _, name := range []string{"files/ftp/x", "files/local", "files/local/../x"} {
		if _, _, err := splitBackupFileEntry(name); err == nil {
			t.Errorf("entry %q was accepted", name)
		}
	}
}

func TestLocalBackupStoreRoundTripSkipsStaging(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	staging := filepath.Join(root, "staging")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "restore-1.zip"), []byte("zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := localBackupStore{root: root, skipDir: staging}
	if err := store.Write(ctx, "rec/part-1", bytes.NewReader([]byte("hello")), 5); err != nil {
		t.Fatal(err)
	}
	var keys []string
	if err := store.List(ctx, func(object backupObject) error {
		keys = append(keys, object.Key)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0] != "rec/part-1" {
		t.Fatalf("listed %v", keys)
	}
	if err := store.Write(ctx, "../escape", bytes.NewReader(nil), 0); err == nil {
		t.Fatal("escaping key was written")
	}
	missing := localBackupStore{root: filepath.Join(root, "missing")}
	if err := missing.List(ctx, func(backupObject) error { return nil }); err != nil {
		t.Fatalf("a missing root is empty, got %v", err)
	}
}
