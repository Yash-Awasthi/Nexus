// Command open-board (alias vb) is the Open Agent Board broker, CLI and
// inspector: a local coordination board for people and their coding agents.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"open-board/pkg/agents"
	"open-board/pkg/api"
	"open-board/pkg/cloud"
	"open-board/pkg/connectors"
	"open-board/pkg/db"
	"open-board/pkg/grammar"
	"open-board/pkg/logfile"
	"open-board/pkg/mcp"
	"open-board/pkg/slice"
	"open-board/pkg/tasks"
	"open-board/pkg/wake"
	"open-board/web"
)

const version = "1.0.0"

func main() {
	os.Exit(run(os.Args[1:]))
}

type global struct {
	server  string
	channel string
	json    bool
}

func run(argv []string) int {
	g, args := splitGlobals(argv)
	if len(args) == 0 {
		printUsage()
		return 2
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "help", "-h", "--help":
		printUsage()
		return 0
	case "version", "--version", "-v":
		fmt.Println("vb " + version)
		return 0
	case "serve":
		return cmdServe(g, rest)
	case "join":
		return cmdJoin(g, rest)
	case "agents":
		return cmdAgents(g, rest)
	case "post":
		return cmdPost(g, rest)
	case "tail":
		return cmdTail(g, rest)
	case "tasks":
		return cmdTasks(g, rest)
	case "claim":
		return cmdClaim(g, rest)
	case "working":
		return cmdWorking(g, rest)
	case "done":
		return cmdDone(g, rest)
	case "fail":
		return cmdFail(g, rest)
	case "lock":
		return cmdLock(g, rest)
	case "unlock":
		return cmdUnlock(g, rest)
	case "locks":
		return cmdLocks(g, rest)
	case "inbox":
		return cmdInbox(g, rest)
	case "slice":
		return cmdSlice(g, rest)
	case "sync":
		return cmdSync(g, rest)
	case "mcp":
		return cmdMCP(g, rest)
	case "discover":
		return cmdDiscover(g, rest)
	case "launch":
		return cmdLaunch(g, rest)
	case "status":
		return cmdStatus(g, rest)
	case "connector", "connectors":
		return cmdConnector(g, rest)
	default:
		fmt.Fprintf(os.Stderr, "error: unknown command %q\n\n", cmd)
		printUsage()
		return 2
	}
}

func printUsage() {
	fmt.Print(`Open Agent Board (vb) ` + version + ` - a local board for people and their agents

usage:
  vb serve [--port 4100] [--dir .board] [--channel default]
  vb status
  vb join --name <agent> [--caps fs:read,fs:write,cmd:run]
  vb agents
  vb post <thread> <message...> [--as <agent>]
  vb tail <thread> [--after <id>] [--follow] [--limit 100]
  vb tasks [<thread>] [--state queued|claimed|working|done|failed]
  vb tasks create <thread> <title...> [--id <id>] [--contract <iface>] [--caps <caps>] [--depends <id>]
  vb claim <task-id> | --next <thread> --as <agent> [--lease 300] [--wait 10m]
  vb working <task-id> --as <agent> [note...]
  vb done <task-id> --as <agent> [summary...] [--force]
  vb fail <task-id> --as <agent> <reason...>
  vb lock <path> [--task <id>] --as <agent>
  vb unlock <path> [--force] [--as <agent>]
  vb locks
  vb inbox --agent <agent> --thread <thread> [--peek] [--wait 30s]
  vb slice <path> <symbol-or-lines>
  vb sync [channel] [--dir .board] [--dry-run]
  vb mcp
  vb discover [--manifests <dir>]
  vb launch [--dir .board] <agent-id> [args...]
  vb connector list|add|remove|tools|call|presets

global flags (any position):
  --server <url>     broker URL (default http://127.0.0.1:4100, env VB_URL)
  --channel <name>   board channel (default default, env VB_CHANNEL)
  --json             print one JSON document, for programs

examples:
  vb serve
  vb post sprint-1 "done: T1 parser keeps task ids" --as claude
  vb tasks create sprint-1 "fix the lock reaper" --contract "locks.Manager"
  vb claim --next sprint-1 --as cline --wait 5m
  vb tail sprint-1 --follow
`)
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func splitGlobals(argv []string) (global, []string) {
	g := global{
		server:  envOr("VB_URL", "http://127.0.0.1:4100"),
		channel: envOr("VB_CHANNEL", "default"),
	}
	var rest []string
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch {
		case a == "--json":
			g.json = true
		case a == "--server" && i+1 < len(argv):
			g.server = argv[i+1]
			i++
		case strings.HasPrefix(a, "--server="):
			g.server = strings.TrimPrefix(a, "--server=")
		case a == "--channel" && i+1 < len(argv):
			g.channel = argv[i+1]
			i++
		case strings.HasPrefix(a, "--channel="):
			g.channel = strings.TrimPrefix(a, "--channel=")
		default:
			rest = append(rest, a)
		}
	}
	return g, rest
}

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse accepts flags before, after, or between positional arguments.
func parse(fs *flag.FlagSet, args []string) ([]string, bool) {
	flagArgs, positional := reorder(fs, args)
	if err := fs.Parse(flagArgs); err != nil {
		fmt.Fprintf(os.Stderr, "vb %s: %v\n", fs.Name(), err)
		return nil, false
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "vb %s: unexpected argument %q\n", fs.Name(), fs.Arg(0))
		return nil, false
	}
	return positional, true
}

func reorder(fs *flag.FlagSet, args []string) (flagArgs, positional []string) {
	isBool := func(name string) bool {
		f := fs.Lookup(name)
		if f == nil {
			return false
		}
		b, ok := f.Value.(interface{ IsBoolFlag() bool })
		return ok && b.IsBoolFlag()
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if len(a) > 1 && a[0] == '-' {
			name := strings.TrimLeft(a, "-")
			if eq := strings.IndexByte(name, '='); eq >= 0 {
				flagArgs = append(flagArgs, a)
				continue
			}
			if fs.Lookup(name) == nil {
				flagArgs = append(flagArgs, a) // let Parse report the unknown flag
				continue
			}
			flagArgs = append(flagArgs, a)
			if !isBool(name) && i+1 < len(args) {
				flagArgs = append(flagArgs, args[i+1])
				i++
			}
			continue
		}
		positional = append(positional, a)
	}
	return flagArgs, positional
}

// ---- HTTP client ----

type apiClient struct {
	base    string
	channel string
	http    *http.Client
}

func newAPIClient(g global) *apiClient {
	return &apiClient{
		base:    strings.TrimRight(g.server, "/"),
		channel: g.channel,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *apiClient) do(method, path string, body any, out any) error {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	target := c.base + path + sep + "channel=" + url.QueryEscape(c.channel)

	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, target, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("broker is not reachable at %s\n  start it with: vb serve", c.base)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("%s answered %s", path, resp.Status)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

func printJSON(v any) int {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fail(err)
	}
	fmt.Println(string(data))
	return 0
}

func fail(err error) int {
	fmt.Fprintf(os.Stderr, "error: %v\n", err)
	return 1
}

func misuse(format string, args ...any) int {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	return 2
}

// ---- server ----

func cmdServe(g global, args []string) int {
	fs := newFlags("serve")
	port := fs.Int("port", 4100, "HTTP port")
	dir := fs.String("dir", ".board", "board directory")
	channel := fs.String("channel", g.channel, "default channel")
	wakePath := fs.String("wake", "", "wake config (default <dir>/wake.json)")
	connectorsPath := fs.String("connectors", "", "connectors file (default <dir>/connectors.json)")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		return misuse("serve takes no positional arguments")
	}

	store, err := api.NewStore(*dir)
	if err != nil {
		return fail(err)
	}
	defer store.Close()

	daemon, err := logfile.Open(filepath.Join(store.Dir(), "daemon.log"))
	if err != nil {
		return fail(err)
	}
	defer daemon.Close()
	daemon.Printf("open-board %s starting on 127.0.0.1:%d, dir %s", version, *port, store.Dir())

	registry, _, regErr := agents.LoadRegistry(agents.DefaultDirs()...)
	if regErr != nil {
		daemon.Printf("agent manifests: %v", regErr)
	}
	configPath := *wakePath
	if configPath == "" {
		configPath = filepath.Join(store.Dir(), "wake.json")
	}
	wakeConfig, err := wake.Load(configPath)
	if err != nil {
		return fail(err)
	}
	launcher := wake.NewLauncher(wakeConfig, registry, store.Dir())
	cloudConfig := cloud.FromEnv()

	srv := api.NewServer(store, *channel)
	srv.Wake = launcher
	srv.Cloud = &cloudConfig

	connectorFile := *connectorsPath
	if connectorFile == "" {
		connectorFile = filepath.Join(store.Dir(), "connectors.json")
	}
	connectorMgr, err := connectors.NewManager(connectorFile, version, daemon.Printf)
	if err != nil {
		return fail(err)
	}
	defer connectorMgr.Close()
	srv.Connectors = connectorMgr
	srv.Log = daemon

	supervisor := agents.NewSupervisor(registry, store.Dir())
	supervisor.Logf = daemon.Printf
	supervisor.OnFailure = func(e agents.Exit) {
		if e.Code == 0 {
			return
		}
		for _, ch := range store.Channels() {
			d, err := store.Get(ch)
			if err != nil {
				daemon.Printf("supervisor: open channel %s: %v", ch, err)
				continue
			}
			requeued, err := d.RequeueAgentTasks(e.Agent)
			if err != nil {
				daemon.Printf("supervisor: requeue %s tasks in %s: %v", e.Agent, ch, err)
				continue
			}
			for _, task := range requeued {
				content := fmt.Sprintf("failed: %s %s exited with code %d; task requeued", task.ID, e.Agent, e.Code)
				_, _ = d.AppendEvent(ch, task.Thread, "supervisor", "failed", content, nil, "")
			}
			if len(requeued) > 0 {
				msg := fmt.Sprintf("supervisor requeued %d task(s) after %s exited with code %d", len(requeued), e.Agent, e.Code)
				srv.SendSystem(ch, msg)
				daemon.Printf("channel %s: %s", ch, msg)
			}
		}
	}
	launcher.Supervisor = supervisor
	srv.Supervisor = supervisor
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	reaper := &tasks.Reaper{
		Channels: store.Channels,
		Reap: func(ch string) (int64, error) {
			d, err := store.Get(ch)
			if err != nil {
				return 0, err
			}
			return d.RevertExpiredTasks()
		},
		OnReclaim: func(ch string, n int64) {
			srv.SendSystem(ch, fmt.Sprintf("reclaimed %d expired task lease(s)", n))
			daemon.Printf("channel %s: reclaimed %d expired task lease(s)", ch, n)
		},
	}
	go reaper.Run(ctx)

	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(web.IndexHTML)
	})

	if launcher.Enabled() {
		daemon.Printf("wake enabled from %s (%d rule(s))", configPath, len(wakeConfig.Agents))
	}

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           withRecovery(srv.Handler(ui), daemon),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()
	time.Sleep(60 * time.Millisecond)

	fmt.Printf("board    http://%s\n", addr)
	fmt.Printf("dir      %s\n", store.Dir())
	fmt.Printf("channel  %s\n", *channel)
	if list := connectorMgr.List(); len(list) > 0 {
		fmt.Printf("plugins  %d connector(s) in %s\n", len(list), connectorMgr.Path())
	}

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fail(err)
		}
		return 0
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
		daemon.Printf("open-board stopped")
		fmt.Println("stopped")
		return 0
	}
}

// withRecovery keeps one bad request from taking the broker down, and records
// the panic in the daemon log.
func withRecovery(next http.Handler, log *logfile.Daily) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				log.Printf("panic serving %s %s: %v", r.Method, r.URL.Path, v)
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---- agents and messages ----

func cmdJoin(g global, args []string) int {
	fs := newFlags("join")
	name := fs.String("name", "", "agent name")
	caps := fs.String("caps", "fs:read,fs:write,cmd:run", "capabilities")
	pid := fs.Int("pid", os.Getpid(), "process id")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		return misuse("join takes flags only, e.g. vb join --name claude")
	}
	if *name == "" {
		return misuse("--name is required")
	}
	c := newAPIClient(g)
	var out json.RawMessage
	if err := c.do(http.MethodPost, "/api/join", map[string]any{"name": *name, "caps": *caps, "pid": *pid}, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Printf("@%s joined %s\n", *name, g.channel)
	return 0
}

func cmdAgents(g global, args []string) int {
	fs := newFlags("agents")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		return misuse("agents takes no arguments")
	}
	c := newAPIClient(g)
	type agentRow struct {
		db.Agent
		Alive *bool `json:"alive"`
	}
	var out struct {
		Agents []agentRow `json:"agents"`
	}
	if err := c.do(http.MethodGet, "/api/agents", nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	if len(out.Agents) == 0 {
		fmt.Printf("no agents on %s yet; join one with: vb join --name <agent>\n", g.channel)
		return 0
	}
	rows := make([][]string, 0, len(out.Agents))
	for _, a := range out.Agents {
		process := "-"
		if a.Alive != nil {
			if *a.Alive {
				process = "alive"
			} else {
				process = "gone"
			}
		}
		rows = append(rows, []string{"@" + a.Name, a.State, process, a.Capabilities, ago(a.LastSeen)})
	}
	printTable([]string{"agent", "state", "process", "caps", "seen"}, rows)
	return 0
}

func cmdPost(g global, args []string) int {
	fs := newFlags("post")
	as := fs.String("as", envOr("VB_ACTOR", "human"), "author name")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) < 2 {
		return misuse("usage: vb post <thread> <message...>")
	}
	thread := pos[0]
	content := strings.Join(pos[1:], " ")
	if _, err := grammar.ParseAndValidate(content); err != nil {
		return fail(err)
	}

	c := newAPIClient(g)
	var out struct {
		Event    db.Event `json:"event"`
		Warnings []string `json:"warnings"`
	}
	if err := c.do(http.MethodPost, "/api/post", map[string]any{
		"channel": g.channel, "thread": thread, "actor": *as, "content": content,
	}, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Printf("#%d %s @%s %s\n", out.Event.ID, out.Event.Thread, out.Event.ActorID, out.Event.Content)
	for _, w := range out.Warnings {
		fmt.Fprintln(os.Stderr, "warning: "+w)
	}
	return 0
}

func cmdTail(g global, args []string) int {
	fs := newFlags("tail")
	after := fs.Int64("after", 0, "start after this message id")
	limit := fs.Int("limit", 100, "messages per read")
	follow := fs.Bool("follow", false, "stream new messages")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) != 1 {
		return misuse("usage: vb tail <thread> [--after <id>] [--follow]")
	}
	thread := pos[0]

	if !*follow {
		c := newAPIClient(g)
		var out struct {
			Thread string     `json:"thread"`
			Events []db.Event `json:"events"`
			Cursor int64      `json:"cursor"`
		}
		if err := c.do(http.MethodGet, fmt.Sprintf("/api/events?thread=%s&after=%d&limit=%d", url.QueryEscape(thread), *after, *limit), nil, &out); err != nil {
			return fail(err)
		}
		if g.json {
			return printJSON(out)
		}
		if len(out.Events) == 0 {
			fmt.Printf("no messages in %s after #%d\n", thread, *after)
			return 0
		}
		for _, e := range out.Events {
			fmt.Println(formatEvent(e))
		}
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cursor := *after
	c := newAPIClient(g)
	for {
		var out struct {
			Events []db.Event `json:"events"`
			Cursor int64      `json:"cursor"`
		}
		path := fmt.Sprintf("/api/events?thread=%s&after=%d&limit=%d", url.QueryEscape(thread), cursor, *limit)
		if err := c.do(http.MethodGet, path, nil, &out); err != nil {
			return fail(err)
		}
		for _, e := range out.Events {
			if g.json {
				data, _ := json.Marshal(e)
				fmt.Println(string(data))
			} else {
				fmt.Println(formatEvent(e))
			}
			if e.ID > cursor {
				cursor = e.ID
			}
		}
		select {
		case <-ctx.Done():
			return 0
		case <-time.After(time.Second):
		}
	}
}

func formatEvent(e db.Event) string {
	ts := e.CreatedAt.Local().Format("15:04:05")
	line := fmt.Sprintf("#%-5d %s @%-12s %s", e.ID, ts, e.ActorID, strings.ReplaceAll(e.Content, "\n", " "))
	if len(line) > 160 {
		line = line[:157] + "..."
	}
	return line
}

// ---- tasks ----

func cmdTasks(g global, args []string) int {
	fs := newFlags("tasks")
	state := fs.String("state", "", "filter by state")
	id := fs.String("id", "", "task id for create")
	contract := fs.String("contract", "", "contract / interface for create")
	caps := fs.String("caps", "", "required capabilities for create")
	depends := fs.String("depends", "", "task id this one waits for")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	c := newAPIClient(g)

	if len(pos) > 0 && pos[0] == "create" {
		if len(pos) < 3 {
			return misuse("usage: vb tasks create <thread> <title...>")
		}
		thread, title := pos[1], strings.Join(pos[2:], " ")
		var out struct {
			Task db.Task `json:"task"`
		}
		err := c.do(http.MethodPost, "/api/tasks", map[string]any{
			"channel": g.channel, "thread": thread, "title": title,
			"id": *id, "contract": *contract, "caps": *caps, "depends_on": *depends,
		}, &out)
		if err != nil {
			return fail(err)
		}
		if g.json {
			return printJSON(out)
		}
		fmt.Printf("created %s  %s\n", out.Task.ID, out.Task.Title)
		return 0
	}

	thread := ""
	if len(pos) > 0 {
		thread = pos[0]
	}
	path := "/api/tasks"
	query := url.Values{}
	if thread != "" {
		query.Set("thread", thread)
	}
	if *state != "" {
		query.Set("state", *state)
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	var out struct {
		Tasks []db.Task `json:"tasks"`
	}
	if err := c.do(http.MethodGet, path, nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	if len(out.Tasks) == 0 {
		fmt.Println("no tasks")
		return 0
	}
	rows := make([][]string, 0, len(out.Tasks))
	for _, t := range out.Tasks {
		owner := ""
		if t.Owner != nil {
			owner = "@" + *t.Owner
		}
		lease := ""
		if t.LeaseUntil != nil {
			lease = "expires " + t.LeaseUntil.Local().Format("15:04:05")
		}
		rows = append(rows, []string{t.ID, t.State, owner, truncate(t.Title, 52), lease})
	}
	printTable([]string{"task", "state", "owner", "title", "lease"}, rows)
	return 0
}

func cmdClaim(g global, args []string) int {
	fs := newFlags("claim")
	as := fs.String("as", envOr("VB_ACTOR", ""), "agent claiming the task")
	lease := fs.Int("lease", tasks.DefaultLeaseSeconds, "lease in seconds")
	next := fs.String("next", "", "claim the next queued task in this thread")
	wait := fs.Duration("wait", 0, "keep trying for this long, e.g. 10m")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if *as == "" {
		return misuse("--as <agent> is required")
	}
	if *next == "" && len(pos) == 0 {
		return misuse("usage: vb claim <task-id> | --next <thread> --as <agent>")
	}
	if *next != "" && len(pos) > 0 {
		return misuse("give a task id or --next, not both")
	}

	c := newAPIClient(g)
	deadline := time.Now().Add(*wait)
	var lastErr error
	for {
		var taskID string
		if *next != "" {
			id, err := nextQueued(c, *next)
			if err != nil {
				lastErr = err
			} else {
				taskID = id
			}
		} else {
			taskID = pos[0]
		}
		if taskID != "" {
			var out struct {
				Task db.Task `json:"task"`
			}
			err := c.do(http.MethodPost, "/api/claim", map[string]any{
				"channel": g.channel, "task_id": taskID, "agent": *as, "lease": *lease,
			}, &out)
			if err == nil {
				if g.json {
					return printJSON(out)
				}
				left := tasks.NormalizeLease(*lease)
				fmt.Printf("claimed %s  yours for %s  %s\n", out.Task.ID, shortDuration(time.Duration(left)*time.Second), out.Task.Title)
				return 0
			}
			lastErr = err
		}
		if *wait <= 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if lastErr == nil {
		lastErr = errors.New("no queued task to claim")
	}
	return fail(lastErr)
}

func nextQueued(c *apiClient, thread string) (string, error) {
	var out struct {
		Tasks []db.Task `json:"tasks"`
	}
	if err := c.do(http.MethodGet, "/api/tasks?thread="+url.QueryEscape(thread)+"&state=queued", nil, &out); err != nil {
		return "", err
	}
	if len(out.Tasks) == 0 {
		return "", fmt.Errorf("no queued tasks in %s", thread)
	}
	sort.Slice(out.Tasks, func(i, j int) bool { return out.Tasks[i].CreatedAt.Before(out.Tasks[j].CreatedAt) })
	return out.Tasks[0].ID, nil
}

func cmdWorking(g global, args []string) int {
	fs := newFlags("working")
	as := fs.String("as", envOr("VB_ACTOR", ""), "agent name")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) < 1 || *as == "" {
		return misuse("usage: vb working <task-id> --as <agent> [note...]")
	}
	content := "working: " + pos[0]
	if len(pos) > 1 {
		content += " " + strings.Join(pos[1:], " ")
	}
	return postAs(g, *as, taskThread(newAPIClient(g), pos[0]), content)
}

func cmdDone(g global, args []string) int {
	fs := newFlags("done")
	as := fs.String("as", envOr("VB_ACTOR", ""), "agent name")
	force := fs.Bool("force", false, "complete as the supervisor")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) < 1 || *as == "" {
		return misuse("usage: vb done <task-id> --as <agent> [summary...]")
	}
	c := newAPIClient(g)
	var out struct {
		Task  db.Task  `json:"task"`
		Event db.Event `json:"event"`
	}
	err := c.do(http.MethodPost, "/api/done", map[string]any{
		"channel": g.channel, "task_id": pos[0], "agent": *as,
		"summary": strings.Join(pos[1:], " "), "force": *force,
	}, &out)
	if err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Printf("completed %s  %s\n", out.Task.ID, out.Task.Title)
	return 0
}

func cmdFail(g global, args []string) int {
	fs := newFlags("fail")
	as := fs.String("as", envOr("VB_ACTOR", ""), "agent name")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) < 2 || *as == "" {
		return misuse("usage: vb fail <task-id> --as <agent> <reason...>")
	}
	return postAs(g, *as, taskThread(newAPIClient(g), pos[0]), "failed: "+pos[0]+" "+strings.Join(pos[1:], " "))
}

// taskThread posts a task update into the thread the task lives in.
func taskThread(c *apiClient, taskID string) string {
	var out struct {
		Task db.Task `json:"task"`
	}
	if err := c.do(http.MethodGet, "/api/tasks/get?id="+url.QueryEscape(taskID), nil, &out); err == nil && out.Task.Thread != "" {
		return out.Task.Thread
	}
	return taskID
}

func postAs(g global, actor, thread, content string) int {
	c := newAPIClient(g)
	var out struct {
		Event    db.Event `json:"event"`
		Warnings []string `json:"warnings"`
	}
	err := c.do(http.MethodPost, "/api/post", map[string]any{
		"channel": g.channel, "thread": thread, "actor": actor, "content": content,
	}, &out)
	if err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Println(formatEvent(out.Event))
	for _, w := range out.Warnings {
		fmt.Fprintln(os.Stderr, "warning: "+w)
	}
	return 0
}

// ---- locks ----

func cmdLock(g global, args []string) int {
	fs := newFlags("lock")
	task := fs.String("task", "", "task the lock belongs to")
	as := fs.String("as", envOr("VB_ACTOR", ""), "agent name")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) != 1 || *as == "" {
		return misuse("usage: vb lock <path> [--task <id>] --as <agent>")
	}
	c := newAPIClient(g)
	var out json.RawMessage
	err := c.do(http.MethodPost, "/api/locks", map[string]any{
		"channel": g.channel, "path": pos[0], "task": *task, "agent": *as,
	}, &out)
	if err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Printf("locked %s  @%s\n", pos[0], *as)
	return 0
}

func cmdUnlock(g global, args []string) int {
	fs := newFlags("unlock")
	as := fs.String("as", envOr("VB_ACTOR", ""), "agent name")
	force := fs.Bool("force", false, "release any agent's lock")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) != 1 {
		return misuse("usage: vb unlock <path> [--force] [--as <agent>]")
	}
	if *as == "" && !*force {
		return misuse("--as <agent> is required unless --force")
	}
	c := newAPIClient(g)
	var out json.RawMessage
	err := c.do(http.MethodDelete, fmt.Sprintf("/api/locks?path=%s&agent=%s&force=%t",
		url.QueryEscape(pos[0]), url.QueryEscape(*as), *force), nil, &out)
	if err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	if *force {
		fmt.Printf("unlocked %s (forced)\n", pos[0])
	} else {
		fmt.Printf("unlocked %s\n", pos[0])
	}
	return 0
}

func cmdLocks(g global, args []string) int {
	fs := newFlags("locks")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		return misuse("locks takes no arguments")
	}
	c := newAPIClient(g)
	var out struct {
		Locks []db.FileLock `json:"locks"`
	}
	if err := c.do(http.MethodGet, "/api/locks", nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	if len(out.Locks) == 0 {
		fmt.Println("no files are locked")
		return 0
	}
	rows := make([][]string, 0, len(out.Locks))
	for _, l := range out.Locks {
		rows = append(rows, []string{l.FilePath, "@" + l.OwnerAgent, l.OwnerTask, ago(l.AcquiredAt)})
	}
	printTable([]string{"path", "agent", "task", "held"}, rows)
	return 0
}

// ---- inbox and slices ----

func cmdInbox(g global, args []string) int {
	fs := newFlags("inbox")
	agent := fs.String("agent", envOr("VB_ACTOR", ""), "your agent name")
	thread := fs.String("thread", "", "thread to read")
	peek := fs.Bool("peek", false, "read without advancing the cursor")
	wait := fs.Duration("wait", 0, "wait for a mention, e.g. 30m")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		if *thread == "" {
			*thread = pos[0]
		}
	}
	if *agent == "" || *thread == "" {
		return misuse("usage: vb inbox --agent <agent> --thread <thread> [--peek] [--wait 30m]")
	}

	c := newAPIClient(g)
	deadline := time.Now().Add(*wait)
	for {
		var out struct {
			Events []db.Event `json:"events"`
			Cursor int64      `json:"cursor"`
		}
		path := fmt.Sprintf("/api/inbox?agent=%s&thread=%s&peek=%t",
			url.QueryEscape(*agent), url.QueryEscape(*thread), *peek)
		if err := c.do(http.MethodGet, path, nil, &out); err != nil {
			return fail(err)
		}
		if len(out.Events) > 0 || *wait <= 0 || time.Now().After(deadline) {
			if g.json {
				return printJSON(out)
			}
			if len(out.Events) == 0 {
				fmt.Printf("no new mentions for @%s in %s\n", *agent, *thread)
				return 0
			}
			for _, e := range out.Events {
				fmt.Println(formatEvent(e))
			}
			return 0
		}
		time.Sleep(time.Second)
	}
}

func cmdSlice(g global, args []string) int {
	if len(args) < 1 {
		return misuse("usage: vb slice <path> <symbol-or-lines>")
	}
	path := args[0]
	target := strings.Join(args[1:], " ")
	out, err := slice.Extract(path, target)
	if err != nil {
		return fail(err)
	}
	fmt.Print(out)
	return 0
}

// ---- sync and local helpers ----

func cmdSync(g global, args []string) int {
	fs := newFlags("sync")
	dir := fs.String("dir", ".board", "board directory")
	dryRun := fs.Bool("dry-run", false, "write the snapshot locally without uploading")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	channel := g.channel
	if len(pos) > 0 {
		channel = pos[0]
	}
	if len(pos) > 1 {
		return misuse("sync takes one channel, or --channel")
	}

	database, err := db.Open(*dir, channel)
	if err != nil {
		return fail(err)
	}
	defer database.Close()

	cfg := cloud.FromEnv()
	if !*dryRun {
		if missing := cfg.Missing(); len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "error: Cloudflare R2 is not configured; missing %s\n", strings.Join(missing, ", "))
			fmt.Fprintln(os.Stderr, "  set the variables, or run: vb sync --dry-run")
			return 1
		}
	}
	res, err := cfg.Snapshot(context.Background(), database, channel, *dryRun)
	if err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(res)
	}
	fmt.Printf("channel   %s\n", res.Channel)
	fmt.Printf("snapshot  %s\n", res.LocalPath)
	fmt.Printf("size      %s\n", humanBytes(res.Bytes))
	fmt.Printf("sha256    %s\n", res.SHA256)
	if res.Encrypted {
		fmt.Println("encrypted yes (AES-256-GCM)")
	}
	if res.Uploaded {
		fmt.Printf("uploaded  %s\n", res.Key)
		if res.URL != "" {
			fmt.Printf("url       %s\n", res.URL)
		}
	} else {
		fmt.Println("uploaded  no (dry run; set CLOUDFLARE_R2_* and OPEN_BOARD_SNAPSHOT_PASSPHRASE to upload)")
	}
	return 0
}

func cmdMCP(g global, args []string) int {
	if len(args) > 0 {
		return misuse("mcp takes no arguments")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	client := mcp.NewClient(g.server, g.channel)
	if err := mcp.Serve(ctx, os.Stdin, os.Stdout, client); err != nil && !errors.Is(err, context.Canceled) {
		return fail(err)
	}
	return 0
}

func cmdDiscover(g global, args []string) int {
	fs := newFlags("discover")
	manifests := fs.String("manifests", "", "manifest directory")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		return misuse("discover takes no arguments")
	}
	dirs := agents.DefaultDirs()
	if *manifests != "" {
		dirs = []string{*manifests}
	}
	reg, used, err := agents.LoadRegistry(dirs...)
	if err != nil {
		return fail(err)
	}
	found := reg.Discover()
	if g.json {
		return printJSON(map[string]any{"dirs": used, "agents": found})
	}
	fmt.Printf("manifests  %s\n\n", strings.Join(used, ", "))
	rows := make([][]string, 0, len(found))
	for _, d := range found {
		status := "missing"
		if d.Problem == "" {
			status = "installed"
		}
		rows = append(rows, []string{d.ID, d.Name, d.Adapter, status, truncate(d.Executable, 58)})
	}
	printTable([]string{"id", "name", "adapter", "state", "executable"}, rows)
	return 0
}

func cmdLaunch(g global, args []string) int {
	// Only --dir is ours; every other flag belongs to the agent being launched.
	dir := ".board"
	var rest []string
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--dir" && i+1 < len(args):
			dir = args[i+1]
			i++
		case strings.HasPrefix(args[i], "--dir="):
			dir = strings.TrimPrefix(args[i], "--dir=")
		default:
			rest = append(rest, args[i])
		}
	}
	if len(rest) < 1 {
		return misuse("usage: vb launch <agent-id> [args...]")
	}
	id := rest[0]
	reg, _, err := agents.LoadRegistry(agents.DefaultDirs()...)
	if err != nil {
		return fail(err)
	}
	m, ok := reg.Get(id)
	if !ok {
		return misuse("unknown agent %q; run vb discover to see the manifests", id)
	}
	logPath := filepath.Join(dir, g.channel, "agents", fmt.Sprintf("%s-%d.log", id, time.Now().Unix()))
	cmd, err := agents.Launch(m, rest[1:], logPath)
	if err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(map[string]any{"agent": id, "pid": cmd.Process.Pid, "log": logPath})
	}
	fmt.Printf("launched %s  pid %d\n", id, cmd.Process.Pid)
	fmt.Printf("log       %s\n", logPath)
	return 0
}

func cmdStatus(g global, args []string) int {
	fs := newFlags("status")
	pos, ok := parse(fs, args)
	if !ok {
		return 2
	}
	if len(pos) > 0 {
		return misuse("status takes no arguments")
	}
	c := newAPIClient(g)
	var out struct {
		Channel  string             `json:"channel"`
		Channels []string           `json:"channels"`
		Version  string             `json:"version"`
		Stats    db.Stats           `json:"stats"`
		Threads  []db.ThreadSummary `json:"threads"`
		Tasks    []db.Task          `json:"tasks"`
		Locks    []db.FileLock      `json:"locks"`
		Agents   []db.Agent         `json:"agents"`
	}
	if err := c.do(http.MethodGet, "/api/overview", nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	open := out.Stats.Tasks[db.StateQueued] + out.Stats.Tasks[db.StateClaimed] + out.Stats.Tasks[db.StateWorking]
	fmt.Printf("board    %s\n", c.base)
	fmt.Printf("channel  %s\n", out.Channel)
	fmt.Printf("events   %d across %d thread(s)\n", out.Stats.Events, out.Stats.Threads)
	fmt.Printf("tasks    %d open, %d done, %d failed\n", open, out.Stats.Tasks[db.StateDone], out.Stats.Tasks[db.StateFailed])
	fmt.Printf("locks    %d\n", out.Stats.Locks)
	fmt.Printf("agents   %d\n", out.Stats.Agents)
	if len(out.Channels) > 1 {
		fmt.Printf("channels %s\n", strings.Join(out.Channels, ", "))
	}
	return 0
}

// ---- formatting ----

func printTable(headers []string, rows [][]string) {
	cols := len(headers)
	widths := make([]int, cols)
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, r := range rows {
		for i := 0; i < cols && i < len(r); i++ {
			if n := len(r[i]); n > widths[i] {
				widths[i] = n
			}
		}
	}
	line := func(cells []string) {
		parts := make([]string, cols)
		for i := 0; i < cols; i++ {
			v := ""
			if i < len(cells) {
				v = cells[i]
			}
			parts[i] = v + strings.Repeat(" ", widths[i]-len(v))
		}
		fmt.Println(strings.TrimRight(strings.Join(parts, "  "), " "))
	}
	line(headers)
	for _, r := range rows {
		line(r)
	}
}

func truncate(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}

func ago(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func shortDuration(d time.Duration) string {
	if d < time.Minute {
		return strconv.Itoa(int(d.Seconds())) + "s"
	}
	return strconv.Itoa(int(d.Minutes())) + "m"
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
