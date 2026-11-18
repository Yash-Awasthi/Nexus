// Package wake launches a sleeping agent when a message mentions it, so idle
// agents cost nothing until someone needs them. Wake is opt-in: without a
// config file the broker never starts a process.
package wake

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"open-board/pkg/agents"
)

// DefaultCooldown stops a chatty thread from spawning an agent on every line.
const DefaultCooldown = 60 * time.Second

// Agent is one wake rule: a manifest id, or an explicit command.
type Agent struct {
	Manifest        string   `json:"manifest,omitempty"`
	Command         string   `json:"command,omitempty"`
	Args            []string `json:"args,omitempty"`
	CooldownSeconds int      `json:"cooldown_seconds,omitempty"`
}

// Config maps an agent name to how it starts.
type Config struct {
	Agents map[string]Agent `json:"agents"`
}

// Load reads a wake config. A missing file is not an error: wake is optional.
func Load(path string) (*Config, error) {
	cfg := &Config{Agents: map[string]Agent{}}
	if path == "" {
		return cfg, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, fmt.Errorf("read wake config: %w", err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse wake config %s: %w", path, err)
	}
	normalized := make(map[string]Agent, len(cfg.Agents))
	for name, rule := range cfg.Agents {
		normalized[normalize(name)] = rule
	}
	cfg.Agents = normalized
	return cfg, nil
}

func normalize(name string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@"))
}

// Rule returns the wake rule for an agent name.
func (c *Config) Rule(name string) (Agent, bool) {
	if c == nil || c.Agents == nil {
		return Agent{}, false
	}
	rule, ok := c.Agents[normalize(name)]
	return rule, ok
}

// Launcher starts agents for mentions, at most once per cooldown.
type Launcher struct {
	cfg      *Config
	registry *agents.Registry
	dir      string
	clock    func() time.Time
	// Supervisor, when set, launches manifest rules itself so their exits can
	// be supervised and their tasks requeued after a failure.
	Supervisor *agents.Supervisor

	mu   sync.Mutex
	last map[string]time.Time
}

// NewLauncher builds a launcher. dir is the board directory that holds logs.
func NewLauncher(cfg *Config, registry *agents.Registry, dir string) *Launcher {
	return &Launcher{cfg: cfg, registry: registry, dir: dir, clock: time.Now, last: map[string]time.Time{}}
}

// Enabled reports whether any wake rule exists.
func (l *Launcher) Enabled() bool {
	return l != nil && l.cfg != nil && len(l.cfg.Agents) > 0
}

// Wake starts an agent for a mention. It returns false when no rule matches or
// the agent is cooling down. The caller decides whether the agent is already
// working.
func (l *Launcher) Wake(agentName, channel, thread, message string) (bool, error) {
	if !l.Enabled() {
		return false, nil
	}
	rule, ok := l.cfg.Rule(agentName)
	if !ok {
		return false, nil
	}

	cooldown := DefaultCooldown
	if rule.CooldownSeconds > 0 {
		cooldown = time.Duration(rule.CooldownSeconds) * time.Second
	}
	name := normalize(agentName)
	now := l.clock()
	l.mu.Lock()
	if last, seen := l.last[name]; seen && now.Sub(last) < cooldown {
		l.mu.Unlock()
		return false, nil
	}
	l.last[name] = now
	l.mu.Unlock()

	vars := map[string]string{
		"agent":   name,
		"channel": channel,
		"thread":  thread,
		"message": oneLine(message, 500),
	}
	if l.Supervisor != nil && rule.Manifest != "" {
		if l.Supervisor.Running(name) {
			return false, nil
		}
		args := append([]string(nil), rule.Args...)
		for i := range args {
			args[i] = substitute(args[i], vars)
		}
		p, err := l.Supervisor.Start(rule.Manifest, args, channel, thread, message)
		if err != nil {
			return false, err
		}
		return p != nil, nil
	}

	command, args, err := l.resolve(rule)
	if err != nil {
		return false, err
	}
	for i := range args {
		args[i] = substitute(args[i], vars)
	}

	logDir := filepath.Join(l.dir, channel, "agents")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return false, err
	}
	logPath := filepath.Join(logDir, name+"-wake.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return false, err
	}
	fmt.Fprintf(logFile, "\n--- %s wake for %s/%s ---\n", now.Format(time.RFC3339), channel, thread)

	cmd := exec.Command(command, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return false, fmt.Errorf("wake %s: %w", name, err)
	}
	go func() {
		_ = cmd.Wait()
		logFile.Close()
	}()
	return true, nil
}

func (l *Launcher) resolve(rule Agent) (string, []string, error) {
	if rule.Command != "" {
		return rule.Command, append([]string(nil), rule.Args...), nil
	}
	if rule.Manifest == "" {
		return "", nil, fmt.Errorf("wake rule needs a command or a manifest")
	}
	if l.registry == nil {
		return "", nil, fmt.Errorf("wake rule names manifest %q but no manifests are loaded", rule.Manifest)
	}
	manifest, ok := l.registry.Get(rule.Manifest)
	if !ok {
		return "", nil, fmt.Errorf("wake rule names unknown manifest %q", rule.Manifest)
	}
	exe, err := l.registry.ResolveExecutable(manifest)
	if err != nil {
		return "", nil, err
	}
	args := rule.Args
	if len(args) == 0 {
		args = manifest.Args
	}
	return exe, append([]string(nil), args...), nil
}

func substitute(s string, vars map[string]string) string {
	for key, value := range vars {
		s = strings.ReplaceAll(s, "{"+key+"}", value)
	}
	return s
}

func oneLine(s string, max int) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " ")
	if len(s) > max {
		return s[:max]
	}
	return s
}
