// Supervised agent runs: a task is claimed, the agent's manifest launches it
// with the task prompt, its output streams from the supervisor log, and a
// clean exit marks the task done. Humans can terminate a run or force work
// back into the queue.
package api

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"open-board/pkg/agents"
	"open-board/pkg/db"
	"open-board/pkg/tasks"
)

// supervisedLease is generous: a real coding turn can take many minutes.
const supervisedLease = 1800

type agentProcessView struct {
	Agent   string    `json:"agent"`
	PID     int       `json:"pid"`
	TaskID  string    `json:"task_id,omitempty"`
	Channel string    `json:"channel"`
	Thread  string    `json:"thread,omitempty"`
	Log     string    `json:"log,omitempty"`
	Started time.Time `json:"started"`
	Running bool      `json:"running"`
}

func processViews(sup *agents.Supervisor) []agentProcessView {
	if sup == nil {
		return []agentProcessView{}
	}
	list := sup.Processes()
	out := make([]agentProcessView, 0, len(list))
	for _, p := range list {
		out = append(out, agentProcessView{
			Agent:   p.Agent,
			PID:     p.PID,
			TaskID:  p.TaskID,
			Channel: p.Channel,
			Thread:  p.Thread,
			Log:     p.LogPath,
			Started: p.Started,
			Running: p.Running(),
		})
	}
	return out
}

func (s *Server) handleAgentRun(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	var req struct {
		Channel string `json:"channel"`
		Agent   string `json:"agent"`
		TaskID  string `json:"task_id"`
		Prompt  string `json:"prompt"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Channel != "" {
		channel = req.Channel
	}
	agent := strings.TrimSpace(strings.TrimPrefix(req.Agent, "@"))
	if !validActor(agent) {
		writeErr(w, http.StatusBadRequest, "agent is required (max 64, no whitespace)")
		return
	}
	if s.Supervisor == nil {
		writeErr(w, http.StatusServiceUnavailable, "no agent supervisor is configured")
		return
	}
	if strings.TrimSpace(req.TaskID) == "" {
		writeErr(w, http.StatusBadRequest, "task_id is required")
		return
	}
	for _, p := range s.Supervisor.Processes() {
		if p.Agent == agent && p.Running() {
			writeErr(w, http.StatusConflict, fmt.Sprintf("%s is already running task %s", agent, p.TaskID))
			return
		}
	}
	t, err := d.ClaimTask(req.TaskID, agent, tasks.NormalizeLease(supervisedLease))
	if err != nil {
		writeBoardErr(w, err)
		return
	}

	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		prompt = taskPrompt(t, channel)
	}
	p, err := s.Supervisor.StartTask(agent, t.ID, nil, channel, t.Thread, prompt)
	if err != nil {
		if _, rerr := d.ForceRequeueTask(t.ID); rerr == nil {
			if t2, gerr := d.GetTask(t.ID); gerr == nil {
				s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t2})
			}
		}
		writeErr(w, http.StatusBadGateway, "could not start "+agent+": "+err.Error())
		return
	}

	_ = d.UpsertAgent(agent, "fs:read,fs:write,cmd:run", p.PID, "working")
	if ev, err := d.AppendEvent(channel, t.Thread, agent, "working",
		fmt.Sprintf("working: %s supervised by %s (pid %d)", t.ID, agent, p.PID), nil, ""); err == nil {
		s.Broadcast(envelope{Channel: channel, Type: "message.posted", Event: ev})
	}
	if t2, err := d.GetTask(t.ID); err == nil {
		s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t2})
	}
	s.SendSystem(channel, fmt.Sprintf("supervisor started @%s for %s (pid %d)", agent, t.ID, p.PID))

	go s.finishTask(d, channel, agent, t.ID, p)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"task":   t,
		"agent":  agent,
		"pid":    p.PID,
		"log":    p.LogPath,
		"prompt": prompt,
	})
}

// finishTask turns a clean supervised exit into a done task. A non-zero exit is
// left to the broker's OnFailure hook, which requeues the agent's work.
func (s *Server) finishTask(d *db.DB, channel, agent, taskID string, p *agents.Process) {
	code, _ := p.Wait()
	if code != 0 {
		return
	}
	t, err := d.CompleteTask(taskID, agent, false)
	if err != nil {
		// A human requeue or another owner must win over the exiting process.
		current, gerr := d.GetTask(taskID)
		if gerr != nil || current.State != db.StateDone {
			s.logf("supervisor: not completing %s after %s exited 0: %v", taskID, agent, err)
			return
		}
		t = current
	}
	released, _ := d.ReleaseLocksForTask(taskID)
	_ = d.SetAgentState(agent, "idle")

	content := fmt.Sprintf("done: %s %s (exit 0)", taskID, t.Title)
	if ev, err := d.AppendEvent(channel, t.Thread, agent, "done", content, nil, ""); err == nil {
		s.Broadcast(envelope{Channel: channel, Type: "message.posted", Event: ev})
	}
	s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
	s.SendSystem(channel, fmt.Sprintf("supervisor: @%s exited 0; %s done", agent, taskID))
	if released > 0 {
		s.SendSystem(channel, fmt.Sprintf("released %d lock(s) held by %s", released, taskID))
	}
}

func (s *Server) handleAgentTerminate(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	channel, _, ok := s.resolve(w, r)
	if !ok {
		return
	}
	var req struct {
		Channel string `json:"channel"`
		Agent   string `json:"agent"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Channel != "" {
		channel = req.Channel
	}
	agent := strings.TrimSpace(strings.TrimPrefix(req.Agent, "@"))
	if !validActor(agent) {
		writeErr(w, http.StatusBadRequest, "agent is required")
		return
	}
	if s.Supervisor == nil {
		writeErr(w, http.StatusServiceUnavailable, "no agent supervisor is configured")
		return
	}
	pid, err := s.Supervisor.Terminate(agent)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	s.SendSystem(channel, fmt.Sprintf("human supervisor terminated @%s (pid %d); its tasks are requeued", agent, pid))
	writeJSON(w, http.StatusOK, map[string]any{"terminated": agent, "pid": pid})
}

func (s *Server) handleTaskRequeue(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	var req struct {
		Channel string `json:"channel"`
		TaskID  string `json:"task_id"`
		Actor   string `json:"actor"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Channel != "" {
		channel = req.Channel
	}
	if strings.TrimSpace(req.TaskID) == "" {
		writeErr(w, http.StatusBadRequest, "task_id is required")
		return
	}
	actor := strings.TrimSpace(req.Actor)
	if actor == "" {
		actor = "human"
	}
	if !validActor(actor) {
		writeErr(w, http.StatusBadRequest, "actor name is not valid")
		return
	}
	t, err := d.ForceRequeueTask(req.TaskID)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	released, _ := d.ReleaseLocksForTask(t.ID)
	content := fmt.Sprintf("stuck: %s force-requeued by %s", t.ID, actor)
	if ev, err := d.AppendEvent(channel, t.Thread, actor, "stuck", content, nil, ""); err == nil {
		s.Broadcast(envelope{Channel: channel, Type: "message.posted", Event: ev})
	}
	s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
	msg := fmt.Sprintf("human supervisor requeued %s", t.ID)
	if released > 0 {
		msg += fmt.Sprintf(" and released %d lock(s)", released)
	}
	s.SendSystem(channel, msg)
	writeJSON(w, http.StatusOK, map[string]any{"task": t, "released_locks": released})
}

// taskPrompt is what a supervised doer is asked to accomplish.
func taskPrompt(t *db.Task, channel string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are the supervised doer for task %s (%q) on Open Agent Board channel %q, thread %q.\n",
		t.ID, t.Title, channel, t.Thread)
	if t.ContractInterface != "" {
		fmt.Fprintf(&b, "Interface contract: %s\n", t.ContractInterface)
	}
	if t.RequiredCaps != "" {
		fmt.Fprintf(&b, "Required capabilities: %s\n", t.RequiredCaps)
	}
	if t.DependsOn != "" {
		fmt.Fprintf(&b, "Depends on task: %s\n", t.DependsOn)
	}
	b.WriteString("Work in the current project directory. Make the change and run the relevant checks. ")
	b.WriteString("Report progress on the board with `vb working` and `vb done` when you finish. ")
	b.WriteString("Keep your final answer short: what changed and what you verified.")
	return b.String()
}

// ---- supervisor log stream ----

const (
	logTailBytes = 32 << 10
	logChunk     = 128 << 10
)

func (s *Server) handleAgentLogs(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = s.Channel
	}
	if _, err := s.Store.Get(channel); err != nil {
		writeBoardErr(w, badRequest("%v", err))
		return
	}
	agent := strings.TrimSpace(strings.TrimPrefix(r.URL.Query().Get("agent"), "@"))
	if !validActor(agent) {
		writeErr(w, http.StatusBadRequest, "agent is required")
		return
	}
	if s.Supervisor == nil {
		writeErr(w, http.StatusServiceUnavailable, "no agent supervisor is configured")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	follow := r.URL.Query().Get("follow") != "0" && r.URL.Query().Get("follow") != "false"

	path := s.Supervisor.LogPath(channel, agent)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	offset := sendLogTail(w, path)
	flusher.Flush()
	if !follow {
		return
	}

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	missing := false
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-poll.C:
			f, err := os.Open(path)
			if err != nil {
				if !missing {
					missing = true
					writeLogEvent(w, "status", "waiting for "+agent+" supervisor output")
					flusher.Flush()
				}
				continue
			}
			if missing {
				missing = false
				writeLogEvent(w, "status", "connected to "+filepath.Base(path))
			}
			next := sendLogFrom(w, f, offset)
			f.Close()
			offset = next
			flusher.Flush()
		}
	}
}

// sendLogTail writes the end of an existing log and returns the offset to
// follow from. A missing log is not an error.
func sendLogTail(w io.Writer, path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		writeLogEvent(w, "status", "waiting for supervisor output")
		return 0
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0
	}
	size := info.Size()
	start := size - logTailBytes
	if start < 0 {
		start = 0
	}
	if start == 0 {
		return sendLogFrom(w, f, 0)
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return 0
	}
	data := make([]byte, size-start)
	n, _ := io.ReadFull(f, data)
	data = data[:n]
	// The tail starts mid-line; drop it so frames are whole lines.
	if i := strings.IndexByte(string(data), '\n'); i >= 0 {
		data = data[i+1:]
	}
	writeLogLines(w, data)
	return size
}

// sendLogFrom emits complete lines after offset and returns the new offset.
func sendLogFrom(w io.Writer, f *os.File, offset int64) int64 {
	info, err := f.Stat()
	if err != nil {
		return offset
	}
	size := info.Size()
	if size < offset {
		offset = 0 // rotated or truncated
	}
	if size == offset {
		return offset
	}
	n := size - offset
	if n > logChunk {
		n = logChunk
	}
	data := make([]byte, n)
	read, _ := f.ReadAt(data, offset)
	data = data[:read]
	end := strings.LastIndexByte(string(data), '\n')
	if end < 0 {
		if read < logChunk {
			return offset // keep a partial line until it is complete
		}
		end = len(data) - 1
	}
	writeLogLines(w, data[:end+1])
	return offset + int64(end+1)
}

func writeLogLines(w io.Writer, data []byte) {
	text := string(data)
	for _, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		writeLogEvent(w, "log", line)
	}
}

func writeLogEvent(w io.Writer, event, line string) {
	line = strings.TrimRight(line, "\r")
	if len(line) > 4000 {
		line = line[:4000] + "…"
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, line)
}
