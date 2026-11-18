package locks_test

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"open-board/pkg/db"
	"open-board/pkg/locks"
)

func newManager(t *testing.T) *locks.Manager {
	t.Helper()
	d, err := db.OpenFile(filepath.Join(t.TempDir(), "board.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return locks.New(d)
}

func TestAcquireAndConflict(t *testing.T) {
	m := newManager(t)
	path := filepath.Join("repo", "src", "db.go")

	lock, err := m.Acquire(path, "T1", "claude")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if !filepath.IsAbs(lock.FilePath) {
		t.Fatalf("lock path should be absolute: %s", lock.FilePath)
	}

	_, err = m.Acquire(path, "T2", "cline")
	var held *locks.HeldError
	if !errors.As(err, &held) {
		t.Fatalf("want a HeldError, got %v", err)
	}
	if !strings.Contains(held.Error(), "claude") || !strings.Contains(held.Error(), "T1") {
		t.Fatalf("the error should name the holder: %s", held.Error())
	}

	if ok, err := m.Release(path, "cline", false); err != nil || ok {
		t.Fatalf("a stranger must not release: ok=%t err=%v", ok, err)
	}
	if ok, err := m.Release(path, "", true); err != nil || !ok {
		t.Fatalf("force should release: ok=%t err=%v", ok, err)
	}
}

func TestKeysFoldCaseOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skip("case folding is a Windows and macOS concern")
	}
	_, key, err := locks.CanonicalPath(filepath.Join("Repo", "File.go"))
	if err != nil {
		t.Fatal(err)
	}
	if key != strings.ToLower(key) {
		t.Fatalf("key should be folded: %s", key)
	}
}

func TestCanonicalPathNeedsAPath(t *testing.T) {
	if _, _, err := locks.CanonicalPath(""); err != nil {
		t.Fatalf("an empty path resolves to the working directory: %v", err)
	}
}
