// Package locks guards file edits: one agent holds a path at a time, and the
// lock survives crashes until its owner finishes or the supervisor forces it.
package locks

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"

	"open-board/pkg/db"
)

// Manager acquires and releases path locks.
type Manager struct {
	db *db.DB
}

// New returns a manager over a channel's database.
func New(database *db.DB) *Manager { return &Manager{db: database} }

// CanonicalPath returns the absolute display path and the case-folded key
// used for conflict detection.
func CanonicalPath(path string) (display, key string, err error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", "", fmt.Errorf("resolve path: %w", err)
	}
	display = filepath.Clean(abs)
	key = display
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		key = strings.ToLower(key)
	}
	return display, key, nil
}

// HeldError reports who holds a path.
type HeldError struct {
	Holder *db.FileLock
}

func (e *HeldError) Error() string {
	if e.Holder == nil {
		return "path is already locked"
	}
	by := e.Holder.OwnerAgent
	if by == "" {
		by = "someone"
	}
	msg := fmt.Sprintf("path is locked by %s", by)
	if e.Holder.OwnerTask != "" {
		msg += fmt.Sprintf(" (task %s)", e.Holder.OwnerTask)
	}
	return msg
}

// Acquire takes the lock on path for agent, or reports the holder.
func (m *Manager) Acquire(path, taskID, agent string) (*db.FileLock, error) {
	display, key, err := CanonicalPath(path)
	if err != nil {
		return nil, err
	}
	ok, holder, err := m.db.AcquireLock(key, display, taskID, agent)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &HeldError{Holder: holder}
	}
	return &db.FileLock{FilePath: display, Key: key, OwnerTask: taskID, OwnerAgent: agent}, nil
}

// Release frees path for its owner, or for anyone when force is set.
func (m *Manager) Release(path, agent string, force bool) (bool, error) {
	_, key, err := CanonicalPath(path)
	if err != nil {
		return false, err
	}
	return m.db.ReleaseLock(key, agent, force)
}

// List returns every held lock.
func (m *Manager) List() ([]db.FileLock, error) { return m.db.ListLocks() }
