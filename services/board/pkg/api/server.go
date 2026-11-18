package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"open-board/pkg/agents"
	"open-board/pkg/cloud"
	"open-board/pkg/db"
	"open-board/pkg/grammar"
	"open-board/pkg/locks"
	"open-board/pkg/tasks"
	"open-board/pkg/wake"
)

// Version is the broker's protocol version, reported by /api/health.
const Version = "1.0.0"

// Logger is the daemon log the server writes operational facts to.
type Logger interface {
	Printf(format string, args ...any)
}

// Server is the board's HTTP surface.
type Server struct {
	Store      *Store
	Channel    string // default channel for requests that name none
	Wake       *wake.Launcher
	Cloud      *cloud.Config
	Supervisor *agents.Supervisor
	Log        Logger

	mu      sync.Mutex
	clients map[chan string]struct{}
	now     func() time.Time
}

// NewServer returns a server over a store.
func NewServer(store *Store, defaultChannel string) *Server {
	if defaultChannel == "" {
		defaultChannel = "default"
	}
	return &Server{
		Store:   store,
		Channel: defaultChannel,
		clients: map[chan string]struct{}{},
		now:     time.Now,
	}
}

type envelope struct {
	Channel string       `json:"channel"`
	Type    string       `json:"type"`
	Event   *db.Event    `json:"event,omitempty"`
	Task    *db.Task     `json:"task,omitempty"`
	Lock    *db.FileLock `json:"lock,omitempty"`
	Agent   *db.Agent    `json:"agent,omitempty"`
	Message string       `json:"message,omitempty"`
}

// Broadcast sends an envelope to every connected inspector.
func (s *Server) Broadcast(env envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	frame := fmt.Sprintf("event: %s\ndata: %s\n\n", env.Type, data)
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.clients {
		select {
		case ch <- frame:
		default:
		}
	}
}

// SendSystem posts a system notice to a channel's inspector stream.
func (s *Server) SendSystem(channel, message string) {
	s.Broadcast(envelope{Channel: channel, Type: "system", Message: message})
}

// Handler returns the server's routes.
func (s *Server) Handler(ui http.Handler) http.Handler {
	mux := http.NewServeMux()
	if ui != nil {
		mux.Handle("/", ui)
	}
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/grammar", s.handleGrammar)
	mux.HandleFunc("/api/channels", s.handleChannels)
	mux.HandleFunc("/api/overview", s.handleOverview)
	mux.HandleFunc("/api/stats", s.handleStats)
	mux.HandleFunc("/api/threads", s.handleThreads)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/api/events/recent", s.handleRecent)
	mux.HandleFunc("/api/stream", s.handleStream)
	mux.HandleFunc("/api/search", s.handleSearch)
	mux.HandleFunc("/api/post", s.handlePost)
	mux.HandleFunc("/api/inbox", s.handleInbox)
	mux.HandleFunc("/api/ack", s.handleAck)
	mux.HandleFunc("/api/tasks", s.handleTasks)
	mux.HandleFunc("/api/tasks/get", s.handleTaskGet)
	mux.HandleFunc("/api/claim", s.handleClaim)
	mux.HandleFunc("/api/renew", s.handleRenew)
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/done", s.handleDone)
	mux.HandleFunc("/api/locks", s.handleLocks)
	mux.HandleFunc("/api/agents", s.handleAgents)
	mux.HandleFunc("/api/agents/logs", s.handleAgentLogs)
	mux.HandleFunc("/api/agents/run", s.handleAgentRun)
	mux.HandleFunc("/api/agents/terminate", s.handleAgentTerminate)
	mux.HandleFunc("/api/tasks/requeue", s.handleTaskRequeue)
	mux.HandleFunc("/api/join", s.handleJoin)

	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// ---- helpers ----

type boardError struct {
	code int
	msg  string
}

func (e *boardError) Error() string { return e.msg }

func badRequest(format string, args ...any) *boardError {
	return &boardError{code: http.StatusBadRequest, msg: fmt.Sprintf(format, args...)}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func writeBoardErr(w http.ResponseWriter, err error) {
	var be *boardError
	var held *locks.HeldError
	switch {
	case errors.As(err, &be):
		writeErr(w, be.code, be.msg)
	case errors.As(err, &held):
		writeErr(w, http.StatusConflict, held.Error())
	case errors.Is(err, db.ErrTaskNotFound):
		writeErr(w, http.StatusNotFound, "task not found")
	case errors.Is(err, db.ErrTaskTaken):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, db.ErrTaskBlocked):
		writeErr(w, http.StatusConflict, "task is waiting on a dependency that is not done")
	case errors.Is(err, db.ErrTaskNotOwned):
		writeErr(w, http.StatusConflict, "task is not yours to change")
	case errors.Is(err, db.ErrTaskExists):
		writeErr(w, http.StatusConflict, err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) resolve(w http.ResponseWriter, r *http.Request) (string, *db.DB, bool) {
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = s.Channel
	}
	d, err := s.Store.Get(channel)
	if err != nil {
		writeBoardErr(w, badRequest("%v", err))
		return "", nil, false
	}
	return channel, d, true
}

func requireMethod(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, m := range methods {
		if r.Method == m {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			writeErr(w, http.StatusBadRequest, "request body is empty")
			return false
		}
		writeErr(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func validName(name string, max int) bool {
	if name == "" || len(name) > max {
		return false
	}
	return !strings.ContainsAny(name, " \t\r\n/\\")
}

func validActor(name string) bool {
	if !validName(name, 64) {
		return false
	}
	for _, r := range name {
		if r < 0x20 {
			return false
		}
	}
	return true
}

// ---- handlers ----

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": Version,
		"channel": s.Channel,
		"dir":     s.Store.Dir(),
		"time":    s.now().UTC(),
	})
}

func (s *Server) handleGrammar(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"verbs":    grammar.Verbs(),
		"word_cap": grammar.WordCap,
		"slice":    "%*% <path> <symbol-or-lines>",
		"mentions": "@name, @all",
	})
}

func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": s.Store.Channels(), "default": s.Channel})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	stats, err := d.Stats()
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": channel, "stats": stats})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	stats, err := d.Stats()
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	threads, err := d.ListThreads(50)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	taskList, err := d.ListTasks("", "")
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if len(taskList) > 200 {
		taskList = taskList[:200]
	}
	lockList, err := d.ListLocks()
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	agentList, err := d.ListAgents()
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	recent, err := d.RecentEvents("", 100)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if threads == nil {
		threads = []db.ThreadSummary{}
	}
	if taskList == nil {
		taskList = []db.Task{}
	}
	if lockList == nil {
		lockList = []db.FileLock{}
	}
	if agentList == nil {
		agentList = []db.Agent{}
	}
	if recent == nil {
		recent = []db.Event{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"channel":  channel,
		"channels": s.Store.Channels(),
		"version":  Version,
		"stats":    stats,
		"threads":  threads,
		"tasks":    taskList,
		"locks":    lockList,
		"agents":   agentViews(agentList),
		"running":  processViews(s.Supervisor),
		"recent":   recent,
		"verbs":    grammar.Verbs(),
		"word_cap": grammar.WordCap,
	})
}

func (s *Server) handleThreads(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	threads, err := d.ListThreads(100)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if threads == nil {
		threads = []db.ThreadSummary{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": threads})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	thread := r.URL.Query().Get("thread")
	if thread == "" {
		writeErr(w, http.StatusBadRequest, "thread is required")
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit == 0 {
		limit = 100
	}
	events, err := d.GetEventsAfter(thread, after, limit)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if events == nil {
		events = []db.Event{}
	}
	var cursor int64 = after
	for _, e := range events {
		if e.ID > cursor {
			cursor = e.ID
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"thread": thread, "events": events, "cursor": cursor})
}

func (s *Server) handleRecent(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, err := d.RecentEvents(r.URL.Query().Get("thread"), limit)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if events == nil {
		events = []db.Event{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "q is required")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, err := d.SearchEvents(q, limit)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if events == nil {
		events = []db.Event{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"query": q, "events": events})
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = s.Channel
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := make(chan string, 64)
	s.mu.Lock()
	s.clients[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.clients, ch)
		s.mu.Unlock()
	}()

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case frame := <-ch:
			if _, err := io.WriteString(w, frame); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

type postRequest struct {
	Channel string `json:"channel"`
	Thread  string `json:"thread"`
	Actor   string `json:"actor"`
	Content string `json:"content"`
}

func (s *Server) handlePost(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req postRequest
	if !decodeBody(w, r, &req) {
		return
	}
	channel := req.Channel
	if channel == "" {
		channel = s.Channel
	}
	d, err := s.Store.Get(channel)
	if err != nil {
		writeBoardErr(w, badRequest("%v", err))
		return
	}
	if !validName(req.Thread, 64) {
		writeErr(w, http.StatusBadRequest, "thread is required (letters, digits, dot, dash, underscore; max 64)")
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

	parsed, err := grammar.ParseAndValidate(req.Content)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	warnings := []string{}
	locker := locks.New(d)
	verb := parsed.Verb
	taskID := grammar.TaskRef(parsed.Argument)

	switch verb {
	case "claim":
		if _, err := d.ClaimTask(taskID, actor, tasks.DefaultLeaseSeconds); err != nil {
			writeBoardErr(w, err)
			return
		}
	case "lock":
		path := strings.Fields(parsed.Argument)
		if len(path) == 0 {
			writeErr(w, http.StatusBadRequest, "lock: needs a path")
			return
		}
		if _, err := locker.Acquire(path[0], taskID, actor); err != nil {
			writeBoardErr(w, err)
			return
		}
	case "working":
		if taskID != "" {
			if _, err := d.RenewTask(taskID, actor, tasks.DefaultLeaseSeconds); err != nil {
				warnings = append(warnings, friendlyTaskWarning(verb, taskID, err))
			} else if _, err := d.SetTaskState(taskID, actor, db.StateWorking); err != nil {
				warnings = append(warnings, friendlyTaskWarning(verb, taskID, err))
			}
		}
	case "done":
		if taskID != "" {
			if _, err := d.CompleteTask(taskID, actor, false); err != nil {
				warnings = append(warnings, friendlyTaskWarning(verb, taskID, err))
			} else {
				releaseTaskLocks(d, taskID)
			}
		}
	case "failed":
		if taskID != "" {
			if _, err := d.SetTaskState(taskID, actor, db.StateFailed); err != nil {
				warnings = append(warnings, friendlyTaskWarning(verb, taskID, err))
			} else {
				releaseTaskLocks(d, taskID)
			}
		}
	case "review-ok":
		if taskID != "" {
			if _, err := d.CompleteTask(taskID, actor, true); err != nil {
				warnings = append(warnings, friendlyTaskWarning(verb, taskID, err))
			} else {
				releaseTaskLocks(d, taskID)
			}
		}
	case "unlock":
		path := strings.Fields(parsed.Argument)
		if len(path) == 0 {
			writeErr(w, http.StatusBadRequest, "unlock: needs a path")
			return
		}
		if ok, err := locker.Release(path[0], actor, false); err != nil {
			writeBoardErr(w, err)
			return
		} else if !ok {
			warnings = append(warnings, "no lock held by "+actor+" on "+path[0])
		}
	}

	sliceRef := ""
	if parsed.IsSlice {
		sliceRef = strings.TrimSpace(parsed.SlicePath + " " + parsed.SliceTarget)
	}
	event, err := d.AppendEvent(channel, req.Thread, actor, parsed.Verb, parsed.Raw, parsed.Mentions, sliceRef)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	agentState := ""
	switch verb {
	case "claim", "working", "lock":
		agentState = "working"
	case "done", "failed", "review-ok":
		agentState = "idle"
	}
	_ = d.TouchAgent(actor, agentState)

	s.Broadcast(envelope{Channel: channel, Type: "message.posted", Event: event})
	if taskID != "" {
		if t, err := d.GetTask(taskID); err == nil {
			s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
		}
	}
	if verb == "lock" || verb == "unlock" {
		if lockList, err := d.ListLocks(); err == nil {
			for i := range lockList {
				l := lockList[i]
				s.Broadcast(envelope{Channel: channel, Type: "lock.updated", Lock: &l})
			}
		}
	}
	s.maybeWake(d, channel, req.Thread, parsed.Mentions, parsed.Raw)

	writeJSON(w, http.StatusCreated, map[string]any{"event": event, "warnings": warnings})
}

func friendlyTaskWarning(verb, taskID string, err error) string {
	switch {
	case errors.Is(err, db.ErrTaskNotFound):
		return fmt.Sprintf("%s: task %s does not exist; the message was posted anyway", verb, taskID)
	case errors.Is(err, db.ErrTaskNotOwned):
		return fmt.Sprintf("%s: task %s is not held by you; the message was posted anyway", verb, taskID)
	default:
		return fmt.Sprintf("%s: %v", verb, err)
	}
}

func releaseTaskLocks(d *db.DB, taskID string) {
	_, _ = d.ReleaseLocksForTask(taskID)
}

func (s *Server) handleInbox(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	agent := r.URL.Query().Get("agent")
	thread := r.URL.Query().Get("thread")
	if agent == "" || thread == "" {
		writeErr(w, http.StatusBadRequest, "agent and thread are required")
		return
	}
	peek := r.URL.Query().Get("peek") == "true" || r.URL.Query().Get("peek") == "1"
	cursor, err := d.GetCursor(agent, thread)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	events, err := d.Mentioned(agent, thread, cursor, 100)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	if events == nil {
		events = []db.Event{}
	}
	next := cursor
	for _, e := range events {
		if e.ID > next {
			next = e.ID
		}
	}
	if !peek && next > cursor {
		if err := d.SetCursor(agent, thread, next); err != nil {
			writeBoardErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"agent":  agent,
		"thread": thread,
		"events": events,
		"cursor": next,
		"unread": len(events),
	})
}

func (s *Server) handleAck(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	var req struct {
		Channel string `json:"channel"`
		Agent   string `json:"agent"`
		Thread  string `json:"thread"`
		Cursor  int64  `json:"cursor"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Agent == "" || req.Thread == "" {
		writeErr(w, http.StatusBadRequest, "agent and thread are required")
		return
	}
	if err := d.SetCursor(req.Agent, req.Thread, req.Cursor); err != nil {
		writeBoardErr(w, err)
		return
	}
	cursor, _ := d.GetCursor(req.Agent, req.Thread)
	writeJSON(w, http.StatusOK, map[string]any{"agent": req.Agent, "thread": req.Thread, "cursor": cursor})
}

type taskRequest struct {
	Channel  string `json:"channel"`
	ID       string `json:"id"`
	Thread   string `json:"thread"`
	Title    string `json:"title"`
	Contract string `json:"contract"`
	Caps     string `json:"caps"`
	Depends  string `json:"depends_on"`
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request) {
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		thread := r.URL.Query().Get("thread")
		state := r.URL.Query().Get("state")
		list, err := d.ListTasks(thread, state)
		if err != nil {
			writeBoardErr(w, err)
			return
		}
		if list == nil {
			list = []db.Task{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"channel": channel, "tasks": list})
	case http.MethodPost:
		var req taskRequest
		if !decodeBody(w, r, &req) {
			return
		}
		if req.Thread == "" || req.Title == "" {
			writeErr(w, http.StatusBadRequest, "thread and title are required")
			return
		}
		if !validName(req.Thread, 64) {
			writeErr(w, http.StatusBadRequest, "thread is not valid")
			return
		}
		t, err := s.createTask(d, channel, req)
		if err != nil {
			writeBoardErr(w, err)
			return
		}
		s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
		writeJSON(w, http.StatusCreated, map[string]any{"task": t})
	default:
		requireMethod(w, r, http.MethodGet, http.MethodPost)
	}
}

// createTask inserts a task. Without an explicit id it allocates the thread's
// next T<n>, retrying when a concurrent create took it first.
func (s *Server) createTask(d *db.DB, channel string, req taskRequest) (*db.Task, error) {
	depends := strings.TrimSpace(req.Depends)
	if id := strings.TrimSpace(req.ID); id != "" {
		if !validName(id, 80) {
			return nil, badRequest("task id is not valid")
		}
		return d.CreateTask(id, channel, req.Thread, req.Title, req.Contract, req.Caps, depends)
	}

	base := 1
	if list, err := d.ListTasks(req.Thread, ""); err == nil {
		base = len(list) + 1
	}
	for i := 0; i < 100; i++ {
		candidate := fmt.Sprintf("%s.T%d", req.Thread, base+i)
		t, err := d.CreateTask(candidate, channel, req.Thread, req.Title, req.Contract, req.Caps, depends)
		if err == nil {
			return t, nil
		}
		if !errors.Is(err, db.ErrTaskExists) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("could not allocate a task id in %s", req.Thread)
}

func (s *Server) handleTaskGet(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	_, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}
	t, err := d.GetTask(id)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
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
		Agent   string `json:"agent"`
		Lease   int    `json:"lease"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.TaskID == "" || req.Agent == "" {
		writeErr(w, http.StatusBadRequest, "task_id and agent are required")
		return
	}
	t, err := d.ClaimTask(req.TaskID, req.Agent, tasks.NormalizeLease(req.Lease))
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	_ = d.SetAgentState(req.Agent, "working")
	s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *Server) handleRenew(w http.ResponseWriter, r *http.Request) {
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
		Agent   string `json:"agent"`
		Lease   int    `json:"lease"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.TaskID == "" || req.Agent == "" {
		writeErr(w, http.StatusBadRequest, "task_id and agent are required")
		return
	}
	t, err := d.RenewTask(req.TaskID, req.Agent, tasks.NormalizeLease(req.Lease))
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	_ = d.SetAgentState(req.Agent, "working")
	s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
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
		Agent   string `json:"agent"`
		State   string `json:"state"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.TaskID == "" || req.Agent == "" {
		writeErr(w, http.StatusBadRequest, "task_id and agent are required")
		return
	}
	t, err := d.SetTaskState(req.TaskID, req.Agent, req.State)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
}

func (s *Server) handleDone(w http.ResponseWriter, r *http.Request) {
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
		Agent   string `json:"agent"`
		Summary string `json:"summary"`
		Force   bool   `json:"force"`
		Thread  string `json:"thread"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.TaskID == "" || req.Agent == "" {
		writeErr(w, http.StatusBadRequest, "task_id and agent are required")
		return
	}
	t, err := d.CompleteTask(req.TaskID, req.Agent, req.Force)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	released, _ := d.ReleaseLocksForTask(req.TaskID)

	summary := strings.TrimSpace(req.Summary)
	if summary == "" {
		summary = t.Title
	}
	content := fmt.Sprintf("done: %s %s", req.TaskID, summary)
	thread := req.Thread
	if thread == "" {
		thread = t.Thread
	}
	event, err := d.AppendEvent(channel, thread, req.Agent, "done", content, grammar.ExtractMentions(content), "")
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	_ = d.SetAgentState(req.Agent, "idle")

	s.Broadcast(envelope{Channel: channel, Type: "message.posted", Event: event})
	s.Broadcast(envelope{Channel: channel, Type: "task.updated", Task: t})
	if released > 0 {
		s.Broadcast(envelope{Channel: channel, Type: "system", Message: fmt.Sprintf("released %d lock(s) held by %s", released, req.TaskID)})
	}
	s.maybeSnapshot(channel, thread)
	writeJSON(w, http.StatusOK, map[string]any{"task": t, "event": event, "released_locks": released})
}

func (s *Server) handleLocks(w http.ResponseWriter, r *http.Request) {
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	locker := locks.New(d)
	switch r.Method {
	case http.MethodGet:
		list, err := locker.List()
		if err != nil {
			writeBoardErr(w, err)
			return
		}
		if list == nil {
			list = []db.FileLock{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"locks": list})
	case http.MethodPost:
		var req struct {
			Channel string `json:"channel"`
			Path    string `json:"path"`
			Task    string `json:"task"`
			Agent   string `json:"agent"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		if req.Path == "" || req.Agent == "" {
			writeErr(w, http.StatusBadRequest, "path and agent are required")
			return
		}
		lock, err := locker.Acquire(req.Path, req.Task, req.Agent)
		if err != nil {
			writeBoardErr(w, err)
			return
		}
		s.Broadcast(envelope{Channel: channel, Type: "lock.updated", Lock: lock})
		writeJSON(w, http.StatusCreated, map[string]any{"lock": lock})
	case http.MethodDelete:
		path := r.URL.Query().Get("path")
		agent := r.URL.Query().Get("agent")
		force := r.URL.Query().Get("force") == "true" || r.URL.Query().Get("force") == "1"
		if path == "" {
			writeErr(w, http.StatusBadRequest, "path is required")
			return
		}
		if agent == "" && !force {
			writeErr(w, http.StatusBadRequest, "agent is required unless force=true")
			return
		}
		released, err := locker.Release(path, agent, force)
		if err != nil {
			writeBoardErr(w, err)
			return
		}
		if !released {
			writeErr(w, http.StatusNotFound, "no lock held by you on that path")
			return
		}
		s.Broadcast(envelope{Channel: channel, Type: "system", Message: "unlocked " + path})
		writeJSON(w, http.StatusOK, map[string]any{"unlocked": path, "force": force})
	default:
		requireMethod(w, r, http.MethodGet, http.MethodPost, http.MethodDelete)
	}
}

// agentView adds OS liveness to a registration's PID, which is only a hint.
type agentView struct {
	db.Agent
	Alive *bool `json:"alive,omitempty"`
}

func agentViews(list []db.Agent) []agentView {
	views := make([]agentView, 0, len(list))
	for _, a := range list {
		view := agentView{Agent: a}
		if a.PID > 0 {
			alive := agents.Alive(a.PID)
			view.Alive = &alive
		}
		views = append(views, view)
	}
	return views
}

func (s *Server) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log.Printf(format, args...)
	}
}

// maybeWake starts a listed agent for each mention, unless it is already
// working. @all is never allowed to spawn every agent.
func (s *Server) maybeWake(d *db.DB, channel, thread string, mentions []string, message string) {
	if s.Wake == nil || !s.Wake.Enabled() || len(mentions) == 0 {
		return
	}
	for _, mention := range mentions {
		if strings.EqualFold(mention, "@all") {
			continue
		}
		name := strings.TrimPrefix(mention, "@")
		if agent, err := d.GetAgent(name); err == nil && agent.State == "working" {
			continue
		}
		go func(name string) {
			started, err := s.Wake.Wake(name, channel, thread, message)
			if err != nil {
				s.logf("wake %s failed: %v", name, err)
				return
			}
			if started {
				s.logf("woke %s for %s/%s", name, channel, thread)
			}
		}(name)
	}
}

// maybeSnapshot uploads a snapshot when a thread's last open task finishes.
func (s *Server) maybeSnapshot(channel, thread string) {
	if s.Cloud == nil || !s.Cloud.Enabled() {
		return
	}
	go func() {
		d, err := s.Store.Get(channel)
		if err != nil {
			s.logf("snapshot skipped: %v", err)
			return
		}
		list, err := d.ListTasks(thread, "")
		if err != nil || len(list) == 0 {
			return
		}
		for _, t := range list {
			if t.State != db.StateDone && t.State != db.StateFailed {
				return // the sprint is still open
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		res, err := s.Cloud.Snapshot(ctx, d, channel, false)
		if err != nil {
			s.logf("sprint snapshot for %s failed: %v", thread, err)
			s.SendSystem(channel, "snapshot failed: "+err.Error())
			return
		}
		s.logf("sprint %s complete; snapshot %s uploaded", thread, res.Key)
		s.SendSystem(channel, fmt.Sprintf("sprint %s complete; snapshot %s uploaded", thread, res.Key))
	}()
}

func (s *Server) handleJoin(w http.ResponseWriter, r *http.Request) { s.handleAgents(w, r) }

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	channel, d, ok := s.resolve(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := d.ListAgents()
		if err != nil {
			writeBoardErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"agents": agentViews(list), "running": processViews(s.Supervisor)})
	case http.MethodPost:
		var req struct {
			Name string `json:"name"`
			Caps string `json:"caps"`
			PID  int    `json:"pid"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		if !validActor(req.Name) {
			writeErr(w, http.StatusBadRequest, "name is required (max 64, no whitespace)")
			return
		}
		if req.Caps == "" {
			req.Caps = "fs:read,fs:write,cmd:run"
		}
		if err := d.UpsertAgent(req.Name, req.Caps, req.PID, "idle"); err != nil {
			writeBoardErr(w, err)
			return
		}
		agent := db.Agent{Name: req.Name, Capabilities: req.Caps, PID: req.PID, State: "idle", LastSeen: s.now().UTC()}
		s.Broadcast(envelope{Channel: channel, Type: "agent.joined", Agent: &agent})
		writeJSON(w, http.StatusCreated, map[string]any{
			"status":  "ok",
			"agent":   agent,
			"message": fmt.Sprintf("welcome %s. Grammar: <verb>: <arg>, %d-word cap, slices with %%*%%", req.Name, grammar.WordCap),
		})
	default:
		requireMethod(w, r, http.MethodGet, http.MethodPost)
	}
}
