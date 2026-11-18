// Supervisor launches agent processes from PocketDesk manifests, captures their
// output, tracks OS liveness, and reports exits so the broker can requeue work
// an agent abandoned.
package agents

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Exit describes a supervised process that has ended.
type Exit struct {
	Agent   string
	TaskID  string
	Channel string
	Thread  string
	PID     int
	Code    int
	Err     error
	Started time.Time
	Ended   time.Time
}

// Process is one supervised agent run.
type Process struct {
	Agent   string
	TaskID  string
	Command string
	LogPath string
	Channel string
	Thread  string
	PID     int
	Started time.Time

	done chan struct{}
	mu   sync.Mutex
	code int
	err  error
}

// Done closes when the process exits.
func (p *Process) Done() <-chan struct{} { return p.done }

// Running reports whether the process has not exited yet.
func (p *Process) Running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// Alive combines the wait state with an OS liveness probe.
func (p *Process) Alive() bool { return p.Running() && Alive(p.PID) }

// Wait blocks until the process exits.
func (p *Process) Wait() (int, error) {
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code, p.err
}

// ExitCode returns the exit code, or -1 while the process still runs.
func (p *Process) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.Running() {
		return -1
	}
	return p.code
}

// Supervisor owns the agent processes the broker starts.
type Supervisor struct {
	registry *Registry
	dir      string

	// Logf records supervisor activity; nil is allowed.
	Logf func(format string, args ...any)
	// OnExit is called for every exit, including success.
	OnExit func(Exit)
	// OnFailure is called when a process exits non-zero.
	OnFailure func(Exit)

	mu      sync.Mutex
	running map[string]*Process
}

// NewSupervisor returns a supervisor that keeps logs under dir.
func NewSupervisor(registry *Registry, dir string) *Supervisor {
	return &Supervisor{registry: registry, dir: dir, running: map[string]*Process{}}
}

// Start launches an agent through its manifest. A second start for an agent
// that is still running returns the existing process. args override the
// manifest's arguments when non-empty.
func (s *Supervisor) Start(agentID string, args []string, channel, thread, message string) (*Process, error) {
	return s.start(agentID, "", args, channel, thread, message, false)
}

// StartTask is Start for one board task: the process records the task, and the
// prompt is appended to the agent's chat arguments. The caller claims the task
// first and decides what an exit code means.
func (s *Supervisor) StartTask(agentID, taskID string, args []string, channel, thread, prompt string) (*Process, error) {
	if strings.TrimSpace(taskID) == "" {
		return nil, fmt.Errorf("task id is required")
	}
	return s.start(agentID, taskID, args, channel, thread, prompt, true)
}

func (s *Supervisor) start(agentID, taskID string, args []string, channel, thread, message string, withPrompt bool) (*Process, error) {
	if s == nil || s.registry == nil {
		return nil, fmt.Errorf("no agent registry is configured")
	}
	agentID = normalizeAgent(agentID)
	if agentID == "" {
		return nil, fmt.Errorf("agent id is required")
	}
	if channel == "" {
		channel = "default"
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.running[agentID]; p != nil && p.Running() {
		if taskID != "" && p.TaskID != taskID {
			return nil, fmt.Errorf("%s is already running task %s", agentID, p.TaskID)
		}
		return p, nil
	}

	manifest, ok := s.registry.Get(agentID)
	if !ok {
		return nil, fmt.Errorf("no manifest for agent %q", agentID)
	}
	exe, err := s.registry.ResolveExecutable(manifest)
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		args = manifest.Args
		if len(manifest.Chat.Args) > 0 {
			args = manifest.Chat.Args
		}
	}
	args = append([]string(nil), args...)
	if withPrompt && strings.TrimSpace(message) != "" {
		args = append(args, message)
	}

	logPath := s.LogPath(channel, agentID)
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}

	started := time.Now()
	fmt.Fprintf(logFile, "\n--- %s supervisor start %s (channel %s, thread %s) ---\n",
		started.Format(time.RFC3339), agentID, channel, thread)
	if message != "" {
		fmt.Fprintf(logFile, "mention: %s\n", oneLine(message, 500))
	}

	cmd := exec.Command(exe, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return nil, fmt.Errorf("start %s: %w", agentID, err)
	}

	p := &Process{
		Agent:   agentID,
		TaskID:  taskID,
		Command: strings.Join(append([]string{exe}, args...), " "),
		LogPath: logPath,
		Channel: channel,
		Thread:  thread,
		PID:     cmd.Process.Pid,
		Started: started,
		done:    make(chan struct{}),
	}
	s.running[agentID] = p
	if s.Logf != nil {
		s.Logf("supervisor started %s pid %d", agentID, p.PID)
	}

	go s.wait(p, cmd, logFile)
	return p, nil
}

func (s *Supervisor) wait(p *Process, cmd *exec.Cmd, logFile *os.File) {
	err := cmd.Wait()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	fmt.Fprintf(logFile, "--- %s exit code %d ---\n", time.Now().Format(time.RFC3339), code)
	logFile.Close()

	p.mu.Lock()
	p.code = code
	p.err = err
	p.mu.Unlock()

	s.mu.Lock()
	if s.running[p.Agent] == p {
		delete(s.running, p.Agent)
	}
	s.mu.Unlock()
	close(p.done)

	exited := Exit{Agent: p.Agent, TaskID: p.TaskID, Channel: p.Channel, Thread: p.Thread, PID: p.PID, Code: code, Err: err, Started: p.Started, Ended: time.Now()}
	if code != 0 && s.Logf != nil {
		s.Logf("supervisor: %s pid %d exited with code %d", p.Agent, p.PID, code)
	}
	if s.OnExit != nil {
		s.OnExit(exited)
	}
	if code != 0 && s.OnFailure != nil {
		s.OnFailure(exited)
	}
}

// Running reports whether an agent currently has a live supervised process.
func (s *Supervisor) Running(agent string) bool {
	if s == nil {
		return false
	}
	agent = normalizeAgent(agent)
	s.mu.Lock()
	p := s.running[agent]
	s.mu.Unlock()
	return p != nil && p.Alive()
}

// Terminate ends an agent's supervised process tree and waits briefly for it
// to exit, so a human supervisor can take a stuck agent down.
func (s *Supervisor) Terminate(agent string) (int, error) {
	if s == nil {
		return 0, fmt.Errorf("no supervisor is configured")
	}
	agent = normalizeAgent(agent)
	s.mu.Lock()
	p := s.running[agent]
	s.mu.Unlock()
	if p == nil || !p.Running() {
		return 0, fmt.Errorf("agent %q is not running", agent)
	}
	if err := terminateProcess(p.PID); err != nil {
		return p.PID, err
	}
	select {
	case <-p.Done():
	case <-time.After(3 * time.Second):
	}
	return p.PID, nil
}

// LogPath is the supervisor log for one agent in one channel.
func (s *Supervisor) LogPath(channel, agent string) string {
	if channel == "" {
		channel = "default"
	}
	return filepath.Join(s.dir, channel, "agents", safeName(normalizeAgent(agent))+"-supervisor.log")
}

// Processes snapshots the supervised processes.
func (s *Supervisor) Processes() []*Process {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Process, 0, len(s.running))
	for _, p := range s.running {
		out = append(out, p)
	}
	return out
}

func normalizeAgent(name string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@"))
}

func safeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "agent"
	}
	return b.String()
}

// oneLine flattens and caps a mention for the log header.
func oneLine(s string, max int) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " ")
	if len(s) > max {
		return s[:max]
	}
	return s
}
