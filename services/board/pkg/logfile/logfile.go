// Package logfile writes the broker's operational log, rotating it daily so
// one file never grows without bound.
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Daily is an io.Writer that keeps today's log at path and moves yesterday's
// to <name>-<YYYY-MM-DD>.log when the date changes.
type Daily struct {
	path string
	now  func() time.Time

	mu  sync.Mutex
	f   *os.File
	day string
}

// Open starts (or appends to) the log at path.
func Open(path string) (*Daily, error) {
	return OpenWithClock(path, time.Now)
}

// OpenWithClock is Open with an injectable clock, for tests.
func OpenWithClock(path string, now func() time.Time) (*Daily, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	d := &Daily{path: path, now: now}
	if err := d.open(now().Format("2006-01-02")); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *Daily) open(day string) error {
	f, err := os.OpenFile(d.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	d.f = f
	d.day = day
	return nil
}

// Write appends a line, rotating first if the date changed.
func (d *Daily) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.f == nil {
		if err := d.open(d.day); err != nil {
			return 0, err
		}
	}
	if today := d.now().Format("2006-01-02"); today != d.day {
		_ = d.f.Close()
		archive := strings.TrimSuffix(d.path, filepath.Ext(d.path)) + "-" + d.day + filepath.Ext(d.path)
		_ = os.Rename(d.path, archive)
		if err := d.open(today); err != nil {
			return 0, err
		}
	}
	return d.f.Write(p)
}

// Printf writes one formatted line.
func (d *Daily) Printf(format string, args ...any) {
	if d == nil {
		return
	}
	fmt.Fprintf(d, "%s "+format+"\n", append([]any{time.Now().Format(time.RFC3339)}, args...)...)
}

// Close closes the current file.
func (d *Daily) Close() error {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.f == nil {
		return nil
	}
	err := d.f.Close()
	d.f = nil
	return err
}
