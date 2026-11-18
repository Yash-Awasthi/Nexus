package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRotatesOnDateChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "daemon.log")
	day := time.Date(2026, 11, 20, 23, 0, 0, 0, time.UTC)
	now := func() time.Time { return day }

	log, err := OpenWithClock(path, now)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()

	if _, err := log.Write([]byte("first day\n")); err != nil {
		t.Fatal(err)
	}

	day = day.Add(2 * time.Hour) // crosses midnight
	if _, err := log.Write([]byte("second day\n")); err != nil {
		t.Fatal(err)
	}

	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(current), "second day") || strings.Contains(string(current), "first day") {
		t.Fatalf("today's log is wrong:\n%s", current)
	}

	archive, err := os.ReadFile(filepath.Join(dir, "daemon-2026-11-20.log"))
	if err != nil {
		t.Fatalf("the previous day should be archived: %v", err)
	}
	if !strings.Contains(string(archive), "first day") {
		t.Fatalf("the archive is wrong:\n%s", archive)
	}
}

func TestPrintfIncludesTimestamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon.log")
	log, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	log.Printf("listening on %s", "127.0.0.1:4100")
	log.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "listening on 127.0.0.1:4100") {
		t.Fatalf("log line missing: %s", data)
	}
	if len(strings.Fields(string(data))) < 3 {
		t.Fatalf("log line should carry a timestamp: %s", data)
	}
}
