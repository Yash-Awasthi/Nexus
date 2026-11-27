package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Connector is one local MCP server the board may call.
type Connector struct {
	Name        string            `json:"name,omitempty"`
	Command     string            `json:"command"`
	Args        []string          `json:"args,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Deny        []string          `json:"deny,omitempty"`
	IdleSeconds int               `json:"idle_seconds,omitempty"`
}

func (c Connector) label() string {
	if len(c.Args) == 0 {
		return c.Command
	}
	return c.Command + " " + strings.Join(c.Args, " ")
}

func (c Connector) idle() time.Duration {
	if c.IdleSeconds > 0 {
		return time.Duration(c.IdleSeconds) * time.Second
	}
	return 5 * time.Minute
}

// Config is the on-disk shape of connectors.json.
type Config struct {
	Connectors map[string]Connector `json:"connectors"`
}

// Status is one row of `vb connector list`.
type Status struct {
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Running bool     `json:"running"`
	Tools   int      `json:"tools"`
	Denied  []string `json:"deny,omitempty"`
}

// Result is what a connector call returns.
type Result struct {
	Connector  string `json:"connector"`
	Tool       string `json:"tool"`
	Text       string `json:"text"`
	DurationMS int64  `json:"duration_ms"`
}

type session struct {
	client   *client
	tools    []Tool
	lastUsed atomic.Int64 // unix nanoseconds; read by the idle reaper
	busy     atomic.Int32 // calls in flight; the reaper leaves these alone
}

func (s *session) touch() { s.lastUsed.Store(time.Now().UnixNano()) }

func (s *session) idleFor() time.Duration {
	return time.Since(time.Unix(0, s.lastUsed.Load()))
}

// Manager owns connectors.json and the child processes it describes. It is
// safe to use from several goroutines and starts nothing until a call is made.
type Manager struct {
	path     string
	version  string
	timeout  time.Duration
	logf     func(string, ...any)
	mu       sync.Mutex
	cfg      Config
	modTime  time.Time
	sessions map[string]*session
	closed   bool
	stop     chan struct{}
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// NewManager loads connectors.json, or starts empty if the file is absent.
func NewManager(path, version string, logf func(string, ...any)) (*Manager, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	m := &Manager{
		path:     abs,
		version:  version,
		timeout:  60 * time.Second,
		logf:     logf,
		modTime:  time.Time{},
		sessions: map[string]*session{},
		stop:     make(chan struct{}),
	}
	if err := m.reload(); err != nil {
		return nil, err
	}
	go m.reap()
	return m, nil
}

// Path returns the absolute connectors.json path.
func (m *Manager) Path() string { return m.path }

// Close stops every child process.
func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	close(m.stop)
	sessions := m.sessions
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	for _, s := range sessions {
		_ = s.client.Close()
	}
}

func (m *Manager) reload() error {
	info, err := os.Stat(m.path)
	if errors.Is(err, os.ErrNotExist) {
		m.cfg = Config{Connectors: map[string]Connector{}}
		m.modTime = time.Time{}
		return nil
	}
	if err != nil {
		return fmt.Errorf("connectors: %w", err)
	}
	if info.ModTime().Equal(m.modTime) && m.cfg.Connectors != nil {
		return nil
	}
	data, err := os.ReadFile(m.path)
	if err != nil {
		return fmt.Errorf("connectors: %w", err)
	}
	var cfg Config
	if len(strings.TrimSpace(string(data))) > 0 {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return fmt.Errorf("connectors: %s is not valid JSON: %w", m.path, err)
		}
	}
	if cfg.Connectors == nil {
		cfg.Connectors = map[string]Connector{}
	}
	for name, c := range cfg.Connectors {
		if !namePattern.MatchString(name) {
			return fmt.Errorf("connectors: %q is not a valid name", name)
		}
		if strings.TrimSpace(c.Command) == "" {
			return fmt.Errorf("connectors: %q has no command", name)
		}
		c.Name = name
		cfg.Connectors[name] = c
	}
	m.cfg = cfg
	m.modTime = info.ModTime()
	return nil
}

func (m *Manager) save() error {
	data, err := json.MarshalIndent(m.cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(m.path), 0o755); err != nil {
		return err
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, m.path); err != nil {
		return err
	}
	info, err := os.Stat(m.path)
	if err == nil {
		m.modTime = info.ModTime()
	}
	return nil
}

// List returns every configured connector without starting any of them.
func (m *Manager) List() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = m.reload()
	out := make([]Status, 0, len(m.cfg.Connectors))
	for name, c := range m.cfg.Connectors {
		st := Status{Name: name, Command: c.label(), Denied: c.Deny}
		if s, ok := m.sessions[name]; ok {
			st.Running = true
			st.Tools = len(s.tools)
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Add stores a connector and reloads the config.
func (m *Manager) Add(name string, c Connector) error {
	if !namePattern.MatchString(name) {
		return fmt.Errorf("connector name %q: use letters, digits, dot, dash or underscore", name)
	}
	if strings.TrimSpace(c.Command) == "" {
		return errors.New("a connector needs a command, e.g. uvx")
	}
	c.Name = name
	m.mu.Lock()
	_ = m.reload()
	if m.cfg.Connectors == nil {
		m.cfg.Connectors = map[string]Connector{}
	}
	m.cfg.Connectors[name] = c
	saveErr := m.save()
	// Re-adding a connector can change its command, so the process that is running under
	// that name is stale even when the save succeeded. Drop it; the next call starts the new
	// command and re-reads tools/list.
	stale := m.sessions[name]
	delete(m.sessions, name)
	m.mu.Unlock()
	if saveErr != nil {
		return saveErr
	}
	if stale != nil {
		_ = stale.client.Close()
	}
	return nil
}

// Remove deletes a connector and stops its process.
func (m *Manager) Remove(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = m.reload()
	if _, ok := m.cfg.Connectors[name]; !ok {
		return fmt.Errorf("no connector named %q", name)
	}
	delete(m.cfg.Connectors, name)
	if err := m.save(); err != nil {
		return err
	}
	if s, ok := m.sessions[name]; ok {
		delete(m.sessions, name)
		go s.client.Close()
	}
	return nil
}

// Tools returns a connector's advertised tools, starting it if needed.
func (m *Manager) Tools(ctx context.Context, name string) ([]Tool, error) {
	s, err := m.session(ctx, name)
	if err != nil {
		return nil, err
	}
	return s.tools, nil
}

// Call invokes one tool on one connector.
func (m *Manager) Call(ctx context.Context, name, tool string, args map[string]any) (Result, error) {
	start := time.Now()
	if strings.TrimSpace(tool) == "" {
		return Result{}, errors.New("a tool name is required")
	}
	s, err := m.session(ctx, name)
	if err != nil {
		return Result{}, err
	}
	// A call that is running is not idle: mark it before the reaper can look, and keep the
	// mark for the whole exchange so a slow tool cannot have its process closed underneath it.
	s.busy.Add(1)
	defer s.busy.Add(-1)
	s.touch()
	if err := m.checkAllowed(name, tool, s.tools); err != nil {
		return Result{}, err
	}
	callCtx, cancel := context.WithTimeout(ctx, m.timeout)
	defer cancel()
	text, err := s.client.CallTool(callCtx, tool, args)
	if err != nil {
		return Result{}, err
	}
	s.touch()
	return Result{Connector: name, Tool: tool, Text: text, DurationMS: time.Since(start).Milliseconds()}, nil
}

func (m *Manager) checkAllowed(name, tool string, tools []Tool) error {
	m.mu.Lock()
	c := m.cfg.Connectors[name]
	m.mu.Unlock()
	for _, denied := range c.Deny {
		if denied == "*" || denied == tool {
			return fmt.Errorf("connector %q refuses %q (it is listed under \"deny\")", name, tool)
		}
	}
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		if t.Name == tool {
			return nil
		}
		names = append(names, t.Name)
	}
	if len(names) == 0 {
		return fmt.Errorf("connector %q exposes no tools", name)
	}
	sort.Strings(names)
	if len(names) > 40 {
		names = names[:40]
	}
	return fmt.Errorf("connector %q does not expose %q; available: %s", name, tool, strings.Join(names, ", "))
}

func (m *Manager) session(ctx context.Context, name string) (*session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errors.New("connectors are closed")
	}
	if err := m.reload(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if s, ok := m.sessions[name]; ok {
		s.touch()
		m.mu.Unlock()
		return s, nil
	}
	c, ok := m.cfg.Connectors[name]
	if !ok {
		avail := make([]string, 0, len(m.cfg.Connectors))
		for n := range m.cfg.Connectors {
			avail = append(avail, n)
		}
		sort.Strings(avail)
		m.mu.Unlock()
		if len(avail) == 0 {
			return nil, fmt.Errorf("no connectors are configured; add one in the inspector or run: vb connector add %s <command>", name)
		}
		return nil, fmt.Errorf("no connector named %q; configured: %s", name, strings.Join(avail, ", "))
	}
	// Start outside the lock so a slow handshake does not block listing.
	m.mu.Unlock()

	cl, err := startClient(ctx, name, c, m.version)
	if err != nil {
		return nil, err
	}
	listCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	tools, err := cl.ListTools(listCtx)
	if err != nil {
		_ = cl.Close()
		return nil, fmt.Errorf("connector %q: %v", name, err)
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = cl.Close()
		return nil, errors.New("connectors are closed")
	}
	if existing, ok := m.sessions[name]; ok {
		existing.touch()
		m.mu.Unlock()
		go cl.Close()
		return existing, nil
	}
	s := &session{client: cl, tools: tools}
	s.touch()
	m.sessions[name] = s
	m.mu.Unlock()
	m.logf("connector %s started (%d tools)", name, len(tools))
	return s, nil
}

func (m *Manager) reap() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.closeIdle()
		}
	}
}

func (m *Manager) closeIdle() {
	m.mu.Lock()
	var closing []*session
	for name, s := range m.sessions {
		c := m.cfg.Connectors[name]
		if s.busy.Load() == 0 && s.idleFor() >= c.idle() {
			delete(m.sessions, name)
			closing = append(closing, s)
			m.logf("connector %s idle, stopped", name)
		}
	}
	m.mu.Unlock()
	for _, s := range closing {
		_ = s.client.Close()
	}
}
