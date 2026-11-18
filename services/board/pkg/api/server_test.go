package api_test

import (
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"open-board/pkg/api"
	"open-board/pkg/cloud"
)

func newBoard(t *testing.T) *httptest.Server { return newBoardWith(t, nil) }

func newBoardWith(t *testing.T, configure func(*api.Server)) *httptest.Server {
	t.Helper()
	store, err := api.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := api.NewServer(store, "default")
	if configure != nil {
		configure(srv)
	}
	ts := httptest.NewServer(srv.Handler(nil))
	t.Cleanup(func() {
		ts.Close()
		store.Close()
	})
	return ts
}

func do(t *testing.T, ts *httptest.Server, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(data) > 0 {
		if err := json.Unmarshal(data, &out); err != nil {
			t.Fatalf("%s %s: bad JSON %q: %v", method, path, data, err)
		}
	}
	return resp.StatusCode, out
}

func TestPostTailAndGrammar(t *testing.T) {
	ts := newBoard(t)

	code, body := do(t, ts, http.MethodPost, "/api/post", map[string]any{
		"thread": "sprint-1", "actor": "claude", "content": "ask: T1 @alice can you review?",
	})
	if code != http.StatusCreated {
		t.Fatalf("post: %d %v", code, body)
	}
	event := body["event"].(map[string]any)
	if event["event_type"] != "ask" || event["actor_id"] != "claude" {
		t.Fatalf("unexpected event: %v", event)
	}
	mentions := event["mentions"].([]any)
	if len(mentions) != 1 || mentions[0] != "@alice" {
		t.Fatalf("mentions were not recorded: %v", mentions)
	}

	code, body = do(t, ts, http.MethodGet, "/api/events?thread=sprint-1&after=0", nil)
	if code != http.StatusOK {
		t.Fatalf("tail: %d %v", code, body)
	}
	if len(body["events"].([]any)) != 1 {
		t.Fatalf("tail lost the event: %v", body)
	}

	for _, bad := range []string{"claim", "claim:", "bogus: x"} {
		code, body = do(t, ts, http.MethodPost, "/api/post", map[string]any{"thread": "sprint-1", "content": bad})
		if code != http.StatusBadRequest {
			t.Fatalf("%q should be a 400, got %d %v", bad, code, body)
		}
	}

	code, body = do(t, ts, http.MethodPost, "/api/post", map[string]any{"thread": "sprint-1", "content": "just talking"})
	if code != http.StatusCreated {
		t.Fatalf("prose should post as a note: %d %v", code, body)
	}
	if body["event"].(map[string]any)["event_type"] != "note" {
		t.Fatalf("prose was not a note: %v", body)
	}

	if code, _ := do(t, ts, http.MethodPost, "/api/post", map[string]any{"thread": "", "content": "hi"}); code != http.StatusBadRequest {
		t.Fatalf("a message without a thread should be refused, got %d", code)
	}
	if code, _ := do(t, ts, http.MethodGet, "/api/post", nil); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /api/post should be 405, got %d", code)
	}
}

func TestTaskLifecycleOverHTTP(t *testing.T) {
	ts := newBoard(t)

	code, body := do(t, ts, http.MethodPost, "/api/tasks", map[string]any{
		"thread": "sprint-1", "title": "fix the parser", "contract": "Parse(string) (Node, error)",
	})
	if code != http.StatusCreated {
		t.Fatalf("create task: %d %v", code, body)
	}
	task := body["task"].(map[string]any)
	id := task["id"].(string)
	if id == "" || task["state"] != "queued" {
		t.Fatalf("unexpected task: %v", task)
	}

	code, body = do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": id, "agent": "claude", "lease": 300})
	if code != http.StatusOK {
		t.Fatalf("claim: %d %v", code, body)
	}
	if body["task"].(map[string]any)["state"] != "claimed" {
		t.Fatalf("task not claimed: %v", body)
	}

	if code, _ = do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": id, "agent": "cline"}); code != http.StatusConflict {
		t.Fatalf("a held task should be 409, got %d", code)
	}

	code, body = do(t, ts, http.MethodPost, "/api/renew", map[string]any{"task_id": id, "agent": "claude", "lease": 600})
	if code != http.StatusOK {
		t.Fatalf("renew: %d %v", code, body)
	}

	code, body = do(t, ts, http.MethodPost, "/api/done", map[string]any{"task_id": id, "agent": "claude", "summary": "tests pass"})
	if code != http.StatusOK {
		t.Fatalf("done: %d %v", code, body)
	}
	if body["task"].(map[string]any)["state"] != "done" {
		t.Fatalf("task not done: %v", body)
	}
	event := body["event"].(map[string]any)
	if !strings.HasPrefix(event["content"].(string), "done: "+id) {
		t.Fatalf("done should post its event: %v", event)
	}

	if code, _ = do(t, ts, http.MethodPost, "/api/done", map[string]any{"task_id": id, "agent": "cline"}); code != http.StatusConflict {
		t.Fatalf("finishing someone else's task should be 409, got %d", code)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": "missing", "agent": "claude"}); code != http.StatusNotFound {
		t.Fatalf("missing task should be 404, got %d", code)
	}
}

func TestDependencyBlocksClaim(t *testing.T) {
	ts := newBoard(t)
	do(t, ts, http.MethodPost, "/api/tasks", map[string]any{"thread": "s", "title": "one", "id": "T1"})
	code, body := do(t, ts, http.MethodPost, "/api/tasks", map[string]any{"thread": "s", "title": "two", "id": "T2", "depends_on": "T1"})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, body)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": "T2", "agent": "claude"}); code != http.StatusConflict {
		t.Fatalf("blocked task should be 409, got %d", code)
	}
	do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": "T1", "agent": "claude"})
	do(t, ts, http.MethodPost, "/api/done", map[string]any{"task_id": "T1", "agent": "claude"})
	if code, body = do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": "T2", "agent": "cline"}); code != http.StatusOK {
		t.Fatalf("unblocked task should claim: %d %v", code, body)
	}
}

func TestLocksOverHTTP(t *testing.T) {
	ts := newBoard(t)
	path := "C:\\repo\\src\\db.go"

	code, body := do(t, ts, http.MethodPost, "/api/locks", map[string]any{"path": path, "task": "T1", "agent": "claude"})
	if code != http.StatusCreated {
		t.Fatalf("lock: %d %v", code, body)
	}

	code, body = do(t, ts, http.MethodPost, "/api/locks", map[string]any{"path": path, "task": "T2", "agent": "cline"})
	if code != http.StatusConflict || !strings.Contains(fmt.Sprint(body["error"]), "claude") {
		t.Fatalf("second lock should be 409 naming claude: %d %v", code, body)
	}

	if code, _ = do(t, ts, http.MethodDelete, "/api/locks?path="+strings.ReplaceAll(path, "\\", "%5C")+"&agent=cline", nil); code != http.StatusNotFound {
		t.Fatalf("a stranger should not unlock: %d", code)
	}

	code, body = do(t, ts, http.MethodDelete, "/api/locks?path="+strings.ReplaceAll(path, "\\", "%5C")+"&agent=claude", nil)
	if code != http.StatusOK {
		t.Fatalf("owner unlock: %d %v", code, body)
	}

	code, body = do(t, ts, http.MethodGet, "/api/locks", nil)
	if code != http.StatusOK || len(body["locks"].([]any)) != 0 {
		t.Fatalf("no locks should remain: %d %v", code, body)
	}
}

func TestInboxCursor(t *testing.T) {
	ts := newBoard(t)
	do(t, ts, http.MethodPost, "/api/post", map[string]any{"thread": "s", "actor": "claude", "content": "ask: T1 @alice look"})

	code, body := do(t, ts, http.MethodGet, "/api/inbox?agent=alice&thread=s", nil)
	if code != http.StatusOK {
		t.Fatalf("inbox: %d %v", code, body)
	}
	if len(body["events"].([]any)) != 1 {
		t.Fatalf("inbox missed the mention: %v", body)
	}

	code, body = do(t, ts, http.MethodGet, "/api/inbox?agent=alice&thread=s", nil)
	if code != http.StatusOK || len(body["events"].([]any)) != 0 {
		t.Fatalf("inbox should advance its cursor: %d %v", code, body)
	}

	do(t, ts, http.MethodPost, "/api/post", map[string]any{"thread": "s", "actor": "cline", "content": "@alice one more"})
	code, body = do(t, ts, http.MethodGet, "/api/inbox?agent=alice&thread=s&peek=true", nil)
	if code != http.StatusOK || len(body["events"].([]any)) != 1 {
		t.Fatalf("peek should see the mention: %d %v", code, body)
	}
	code, body = do(t, ts, http.MethodGet, "/api/inbox?agent=alice&thread=s", nil)
	if len(body["events"].([]any)) != 1 {
		t.Fatalf("peek must not advance the cursor: %v", body)
	}
}

func TestOverviewAndChannels(t *testing.T) {
	ts := newBoard(t)
	do(t, ts, http.MethodPost, "/api/post", map[string]any{"thread": "s", "content": "hello"})
	do(t, ts, http.MethodPost, "/api/tasks", map[string]any{"thread": "s", "title": "work"})
	do(t, ts, http.MethodPost, "/api/join", map[string]any{"name": "claude", "caps": "fs:write"})

	code, body := do(t, ts, http.MethodGet, "/api/overview", nil)
	if code != http.StatusOK {
		t.Fatalf("overview: %d %v", code, body)
	}
	if body["channel"] != "default" {
		t.Fatalf("unexpected channel: %v", body["channel"])
	}
	stats := body["stats"].(map[string]any)
	// The author of a message is registered, so the joined agent and "human" both count.
	if stats["events"].(float64) != 1 || stats["agents"].(float64) != 2 {
		t.Fatalf("unexpected stats: %v", stats)
	}
	if len(body["tasks"].([]any)) != 1 || len(body["threads"].([]any)) != 1 {
		t.Fatalf("overview is missing data: %v", body)
	}

	code, body = do(t, ts, http.MethodGet, "/api/overview?channel=../etc", nil)
	if code != http.StatusBadRequest {
		t.Fatalf("path traversal in a channel should be refused: %d %v", code, body)
	}

	code, body = do(t, ts, http.MethodGet, "/api/channels", nil)
	if code != http.StatusOK || len(body["channels"].([]any)) == 0 {
		t.Fatalf("channels: %d %v", code, body)
	}

	code, body = do(t, ts, http.MethodPost, "/api/post", map[string]any{"channel": "other", "thread": "s", "content": "in another channel"})
	if code != http.StatusCreated {
		t.Fatalf("a second channel should work: %d %v", code, body)
	}
	code, body = do(t, ts, http.MethodGet, "/api/channels", nil)
	if len(body["channels"].([]any)) != 2 {
		t.Fatalf("the new channel should be listed: %v", body)
	}

	// Channels are separate databases: a write in one is invisible in the other.
	code, body = do(t, ts, http.MethodGet, "/api/events?channel=default&thread=s", nil)
	if code != http.StatusOK || len(body["events"].([]any)) != 1 {
		t.Fatalf("the default channel should hold only its own event: %d %v", code, body)
	}
	code, body = do(t, ts, http.MethodGet, "/api/events?channel=other&thread=s", nil)
	if code != http.StatusOK || len(body["events"].([]any)) != 1 {
		t.Fatalf("the other channel should hold only its own event: %d %v", code, body)
	}
	otherEvent := body["events"].([]any)[0].(map[string]any)
	if otherEvent["content"] != "in another channel" {
		t.Fatalf("channels are not isolated: %v", otherEvent)
	}
}

func TestAgentLivenessFromPID(t *testing.T) {
	ts := newBoard(t)
	do(t, ts, http.MethodPost, "/api/join", map[string]any{"name": "running", "pid": os.Getpid()})
	do(t, ts, http.MethodPost, "/api/join", map[string]any{"name": "gone", "pid": 99999999})

	code, body := do(t, ts, http.MethodGet, "/api/agents", nil)
	if code != http.StatusOK {
		t.Fatalf("agents: %d %v", code, body)
	}
	found := map[string]*bool{}
	for _, raw := range body["agents"].([]any) {
		agent := raw.(map[string]any)
		var alive *bool
		if v, ok := agent["alive"].(bool); ok {
			alive = &v
		}
		found[agent["name"].(string)] = alive
	}
	if found["running"] == nil || !*found["running"] {
		t.Fatalf("this test's own pid should be alive: %v", found["running"])
	}
	if found["gone"] == nil || *found["gone"] {
		t.Fatalf("a dead pid should be reported gone: %v", found["gone"])
	}
}

func TestConcurrentTaskCreationAllocatesUniqueIDs(t *testing.T) {
	ts := newBoard(t)
	const creates = 12

	var wg sync.WaitGroup
	ids := make(chan string, creates)
	errs := make(chan error, creates)
	for i := 0; i < creates; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			body, err := json.Marshal(map[string]any{"thread": "race", "title": fmt.Sprintf("task %d", n)})
			if err != nil {
				errs <- err
				return
			}
			resp, err := ts.Client().Post(ts.URL+"/api/tasks", "application/json", bytes.NewReader(body))
			if err != nil {
				errs <- err
				return
			}
			defer resp.Body.Close()
			data, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusCreated {
				errs <- fmt.Errorf("status %d: %s", resp.StatusCode, data)
				return
			}
			var out struct {
				Task struct {
					ID string `json:"id"`
				} `json:"task"`
			}
			if err := json.Unmarshal(data, &out); err != nil {
				errs <- err
				return
			}
			ids <- out.Task.ID
		}(i)
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent create failed: %v", err)
	}

	seen := map[string]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate task id allocated: %s", id)
		}
		seen[id] = true
	}
	if len(seen) != creates {
		t.Fatalf("want %d tasks, got %d", creates, len(seen))
	}

	code, body := do(t, ts, http.MethodPost, "/api/tasks", map[string]any{"thread": "race", "title": "explicit", "id": "race.T1"})
	if code != http.StatusConflict {
		t.Fatalf("an explicit duplicate id should conflict, got %d %v", code, body)
	}
}

func TestSprintCompletionUploadsSnapshot(t *testing.T) {
	type upload struct {
		path string
		body []byte
	}
	uploads := make(chan upload, 4)
	objectStore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		uploads <- upload{path: r.URL.Path, body: body}
		w.WriteHeader(http.StatusOK)
	}))
	defer objectStore.Close()

	t.Setenv("CLOUDFLARE_R2_ENDPOINT", objectStore.URL)
	t.Setenv("CLOUDFLARE_R2_BUCKET", "test-bucket")
	t.Setenv("CLOUDFLARE_R2_ACCESS_KEY_ID", "test-key")
	t.Setenv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("OPEN_BOARD_SNAPSHOT_PASSPHRASE", "test-passphrase")
	cfg := cloud.FromEnv()
	if !cfg.Enabled() {
		t.Fatalf("test R2 config should be enabled: %v", cfg.Missing())
	}
	ts := newBoardWith(t, func(s *api.Server) { s.Cloud = &cfg })

	do(t, ts, http.MethodPost, "/api/tasks", map[string]any{"thread": "sprint-9", "title": "one", "id": "sprint-9.T1"})
	do(t, ts, http.MethodPost, "/api/tasks", map[string]any{"thread": "sprint-9", "title": "two", "id": "sprint-9.T2"})
	for _, id := range []string{"sprint-9.T1", "sprint-9.T2"} {
		if code, body := do(t, ts, http.MethodPost, "/api/claim", map[string]any{"task_id": id, "agent": "claude"}); code != http.StatusOK {
			t.Fatalf("claim %s: %d %v", id, code, body)
		}
	}

	// The first completion leaves the sprint open: no upload.
	if code, body := do(t, ts, http.MethodPost, "/api/done", map[string]any{"task_id": "sprint-9.T1", "agent": "claude"}); code != http.StatusOK {
		t.Fatalf("done: %d %v", code, body)
	}
	select {
	case up := <-uploads:
		t.Fatalf("a snapshot was uploaded before the sprint finished: %s", up.path)
	case <-time.After(300 * time.Millisecond):
	}

	// The last completion closes it.
	if code, body := do(t, ts, http.MethodPost, "/api/done", map[string]any{"task_id": "sprint-9.T2", "agent": "claude"}); code != http.StatusOK {
		t.Fatalf("done: %d %v", code, body)
	}
	var up upload
	select {
	case up = <-uploads:
	case <-time.After(5 * time.Second):
		t.Fatal("finishing the sprint did not upload a snapshot")
	}
	if !strings.Contains(up.path, "/test-bucket/snapshots/default/") || !strings.HasSuffix(up.path, ".sqlite.gz.enc") {
		t.Fatalf("unexpected snapshot key: %s", up.path)
	}
	if len(up.body) < 2 || up.body[0] == 0x1f && up.body[1] == 0x8b {
		t.Fatalf("the uploaded snapshot is plain gzip, not encrypted: % x", up.body[:min(len(up.body), 8)])
	}

	// The broker's upload decrypts with the passphrase and opens as the real
	// channel database, with both completions in the sprint's log.
	plain, err := cloud.DecryptSnapshot("test-passphrase", up.body)
	if err != nil {
		t.Fatalf("decrypt uploaded snapshot: %v", err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(plain))
	if err != nil {
		t.Fatalf("decrypted snapshot is not gzip: %v", err)
	}
	database, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "sprint-9.sqlite")
	if err := os.WriteFile(path, database, 0o600); err != nil {
		t.Fatal(err)
	}
	handle, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	var events int
	if err := handle.QueryRow("SELECT COUNT(*) FROM events WHERE thread = 'sprint-9'").Scan(&events); err != nil {
		t.Fatalf("query decrypted snapshot: %v", err)
	}
	if events != 2 {
		t.Fatalf("want both sprint completions in the snapshot, got %d", events)
	}
}
