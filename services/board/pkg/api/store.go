// Package api serves the board protocol over local HTTP and SSE, and hosts
// the embedded inspector.
package api

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"open-board/pkg/db"
)

var channelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidChannel reports whether a channel name is safe to use as a directory.
func ValidChannel(name string) bool {
	return channelPattern.MatchString(name) && !strings.Contains(name, "..")
}

// Store keeps one SQLite database per channel, opened on demand.
type Store struct {
	dir string
	mu  sync.Mutex
	dbs map[string]*db.DB
}

// NewStore mounts a board directory.
func NewStore(dir string) (*Store, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("create board directory: %w", err)
	}
	return &Store{dir: abs, dbs: map[string]*db.DB{}}, nil
}

// Dir returns the absolute board directory.
func (s *Store) Dir() string { return s.dir }

// Get returns a channel's database, opening it if needed.
func (s *Store) Get(channel string) (*db.DB, error) {
	if channel == "" {
		channel = "default"
	}
	if !ValidChannel(channel) {
		return nil, fmt.Errorf("invalid channel %q: use letters, digits, dot, dash or underscore", channel)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.dbs[channel]; ok {
		return d, nil
	}
	d, err := db.Open(s.dir, channel)
	if err != nil {
		return nil, err
	}
	s.dbs[channel] = d
	return d, nil
}

// Channels lists channels on disk plus any opened in memory, sorted.
func (s *Store) Channels() []string {
	seen := map[string]bool{}
	entries, err := os.ReadDir(s.dir)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() && ValidChannel(e.Name()) {
				seen[e.Name()] = true
			}
		}
	}
	s.mu.Lock()
	for name := range s.dbs {
		seen[name] = true
	}
	s.mu.Unlock()

	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Close closes every open channel.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var firstErr error
	for name, d := range s.dbs {
		if err := d.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(s.dbs, name)
	}
	return firstErr
}
