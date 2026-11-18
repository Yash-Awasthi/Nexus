// Package e2e runs a full four-agent sprint against a real broker: concurrent
// claims, lock collisions, a %*% slice relay, a crashed agent recovered by the
// lease reaper, and the encrypted snapshot the sprint closure uploads.
package e2e

import (
	"bytes"
	"compress/gzip"
	"context"
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
	"open-board/pkg/db"
	"open-board/pkg/slice"
	"open-board/pkg/tasks"
)

const (
	thread     = "sprint-5"
	passphrase = "sprint-5 snapshot passphrase"
)

type upload struct {
	path string
	body []byte
}

type claimResult struct {
	agent string
	code  int
	body  map[string]any
	err   error
}

func call(ts *httptest.Server, method, path string, body any) (int, map[string]any, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(data) > 0 {
		if err := json.Unmarshal(data, &out); err != nil {
			return resp.StatusCode, nil, fmt.Errorf("bad JSON %q: %w", data, err)
		}
	}
	return resp.StatusCode, out, nil
}

func mustCall(t *testing.T, ts *httptest.Server, method, path string, body any) (int, map[string]any) {
	t.Helper()
	code, out, err := call(ts, method, path, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return code, out
}

func TestFourAgentSprint(t *testing.T) {
	dir := t.TempDir()
	store, err := api.NewStore(dir)
	if err != nil {
		t.Fatal(err)
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

	cfg := cloud.Config{
		Endpoint:        objectStore.URL,
		Bucket:          "test-bucket",
		AccessKeyID:     "test-key",
		SecretAccessKey: "test-secret",
		Region:          "auto",
		Prefix:          "snapshots",
		Passphrase:      passphrase,
	}
	srv := api.NewServer(store, "default")
	srv.Cloud = &cfg
	ts := httptest.NewServer(srv.Handler(nil))
	defer func() {
		ts.Close()
		store.Close()
	}()

	// Four tasks: T1 -> T2, T3 in parallel, T4 after T3.
	for _, task := range []struct{ id, dep string }{
		{"T1", ""}, {"T2", "T1"}, {"T3", ""}, {"T4", "T3"},
	} {
		id := thread + "." + task.id
		body := map[string]any{"thread": thread, "id": id, "title": "work " + task.id}
		if task.dep != "" {
			body["depends_on"] = thread + "." + task.dep
		}
		if code, out := mustCall(t, ts, http.MethodPost, "/api/tasks", body); code != http.StatusCreated {
			t.Fatalf("create %s: %d %v", id, code, out)
		}
	}

	for _, agent := range []string{"antigravity", "cline", "claude-desktop", "aider"} {
		if code, out := mustCall(t, ts, http.MethodPost, "/api/join", map[string]any{"name": agent}); code != http.StatusCreated {
			t.Fatalf("join %s: %d %v", agent, code, out)
		}
	}

	// Two agents race for T1. Exactly one wins; the other sees 409.
	results := make(chan claimResult, 2)
	var wg sync.WaitGroup
	for _, agent := range []string{"antigravity", "cline"} {
		wg.Add(1)
		go func(agent string) {
			defer wg.Done()
			code, out, err := call(ts, http.MethodPost, "/api/claim", map[string]any{
				"task_id": thread + ".T1", "agent": agent, "lease": 300,
			})
			results <- claimResult{agent: agent, code: code, body: out, err: err}
		}(agent)
	}
	wg.Wait()
	close(results)
	var winner, loser string
	conflicts, wins := 0, 0
	for res := range results {
		if res.err != nil {
			t.Fatalf("claim: %v", res.err)
		}
		switch res.code {
		case http.StatusOK:
			wins++
			winner = res.agent
		case http.StatusConflict:
			conflicts++
			loser = res.agent
			if !strings.Contains(fmt.Sprint(res.body["error"]), "held") {
				t.Fatalf("409 should explain the held task: %v", res.body)
			}
		default:
			t.Fatalf("unexpected claim status %d: %v", res.code, res.body)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("want one winner and one 409, got wins=%d conflicts=%d", wins, conflicts)
	}

	// The loser takes the parallel task and claims a file lock on it.
	if code, out := mustCall(t, ts, http.MethodPost, "/api/claim", map[string]any{
		"task_id": thread + ".T3", "agent": loser, "lease": 30,
	}); code != http.StatusOK {
		t.Fatalf("loser claim T3: %d %v", code, out)
	}

	lockPath, err := filepath.Abs(filepath.Join("..", "..", "pkg", "db", "sqlite.go"))
	if err != nil {
		t.Fatal(err)
	}
	if code, out := mustCall(t, ts, http.MethodPost, "/api/locks", map[string]any{
		"path": lockPath, "task": thread + ".T1", "agent": winner,
	}); code != http.StatusCreated {
		t.Fatalf("winner lock: %d %v", code, out)
	}
	code, out := mustCall(t, ts, http.MethodPost, "/api/locks", map[string]any{
		"path": lockPath, "task": thread + ".T3", "agent": loser,
	})
	if code != http.StatusConflict || !strings.Contains(fmt.Sprint(out["error"]), winner) {
		t.Fatalf("a colliding lock must be 409 naming %s: %d %v", winner, code, out)
	}

	// A 250-word %*% slice request bypasses the 200-word cap; the extracted
	// reply is likewise not word-capped.
	longRequest := "%*% " + lockPath + " func Open " + strings.Repeat("context ", 250)
	code, out = mustCall(t, ts, http.MethodPost, "/api/post", map[string]any{
		"thread": thread, "actor": "claude-desktop", "content": longRequest,
	})
	if code != http.StatusCreated {
		t.Fatalf("slice request was capped: %d %v", code, out)
	}
	event := out["event"].(map[string]any)
	if event["event_type"] != "slice" || !strings.HasPrefix(fmt.Sprint(event["slice_ref"]), lockPath) {
		t.Fatalf("slice relay was not recorded: %v", event)
	}
	extracted, err := slice.Extract(lockPath, "func Open")
	if err != nil {
		t.Fatalf("extract slice: %v", err)
	}
	if !strings.Contains(extracted, "```go") || !strings.Contains(extracted, "func Open(") {
		t.Fatalf("slice reply is not a code fence with the symbol: %q", extracted)
	}

	// T1 finishes, releases its lock, and unblocks T2.
	if code, out := mustCall(t, ts, http.MethodPost, "/api/done", map[string]any{
		"task_id": thread + ".T1", "agent": winner, "summary": "core done",
	}); code != http.StatusOK {
		t.Fatalf("winner done: %d %v", code, out)
	}
	if code, out := mustCall(t, ts, http.MethodGet, "/api/locks", nil); code != http.StatusOK || len(out["locks"].([]any)) != 0 {
		t.Fatalf("done should release the file lock: %d %v", code, out)
	}
	if code, out := mustCall(t, ts, http.MethodPost, "/api/claim", map[string]any{
		"task_id": thread + ".T2", "agent": "claude-desktop",
	}); code != http.StatusOK {
		t.Fatalf("T2 should be claimable after T1: %d %v", code, out)
	}
	if code, out := mustCall(t, ts, http.MethodPost, "/api/done", map[string]any{
		"task_id": thread + ".T2", "agent": "claude-desktop",
	}); code != http.StatusOK {
		t.Fatalf("T2 done: %d %v", code, out)
	}

	// The sprint is still open (T3/T4), so no snapshot may go out yet.
	select {
	case up := <-uploads:
		t.Fatalf("snapshot uploaded before sprint closure: %s", up.path)
	case <-time.After(300 * time.Millisecond):
	}

	// The loser goes to working and then "crashes": its lease is in the past.
	if code, out := mustCall(t, ts, http.MethodPost, "/api/state", map[string]any{
		"task_id": thread + ".T3", "agent": loser, "state": "working",
	}); code != http.StatusOK {
		t.Fatalf("T3 working: %d %v", code, out)
	}
	databasePath := filepath.Join(dir, "default", "board.sqlite")
	handle, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE tasks SET lease_until = ? WHERE id = ?`, time.Now().Add(-time.Minute).UnixMilli(), thread+".T3"); err != nil {
		handle.Close()
		t.Fatalf("expire lease: %v", err)
	}
	handle.Close()

	ctx, cancel := context.WithCancel(context.Background())
	reaper := &tasks.Reaper{
		Channels: store.Channels,
		Reap: func(ch string) (int64, error) {
			d, err := store.Get(ch)
			if err != nil {
				return 0, err
			}
			return d.RevertExpiredTasks()
		},
		Interval: 50 * time.Millisecond,
	}
	go reaper.Run(ctx)

	deadline := time.Now().Add(5 * time.Second)
	for {
		code, out := mustCall(t, ts, http.MethodGet, "/api/tasks/get?id="+thread+".T3", nil)
		if code != http.StatusOK {
			t.Fatalf("T3 get: %d %v", code, out)
		}
		if out["task"].(map[string]any)["state"] == db.StateQueued {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the reaper did not requeue the crashed task: %v", out)
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancel()

	// A fourth agent recovers T3, then finishes the dependent review task.
	if code, out := mustCall(t, ts, http.MethodPost, "/api/claim", map[string]any{
		"task_id": thread + ".T3", "agent": "aider",
	}); code != http.StatusOK {
		t.Fatalf("aider should re-claim T3: %d %v", code, out)
	}
	if code, out := mustCall(t, ts, http.MethodPost, "/api/done", map[string]any{
		"task_id": thread + ".T3", "agent": "aider",
	}); code != http.StatusOK {
		t.Fatalf("aider done T3: %d %v", code, out)
	}
	if code, out := mustCall(t, ts, http.MethodPost, "/api/claim", map[string]any{
		"task_id": thread + ".T4", "agent": "aider",
	}); code != http.StatusOK {
		t.Fatalf("T4 should be claimable after T3: %d %v", code, out)
	}
	if code, out := mustCall(t, ts, http.MethodPost, "/api/done", map[string]any{
		"task_id": thread + ".T4", "agent": "aider",
	}); code != http.StatusOK {
		t.Fatalf("T4 done: %d %v", code, out)
	}

	// Closing the sprint uploads one encrypted snapshot.
	var up upload
	select {
	case up = <-uploads:
	case <-time.After(10 * time.Second):
		t.Fatal("sprint closure did not upload a snapshot")
	}
	if !strings.Contains(up.path, "/test-bucket/snapshots/default/") || !strings.HasSuffix(up.path, ".sqlite.gz.enc") {
		t.Fatalf("unexpected snapshot key: %s", up.path)
	}
	if len(up.body) < 2 || up.body[0] == 0x1f && up.body[1] == 0x8b {
		t.Fatalf("snapshot is not encrypted: % x", up.body[:min(len(up.body), 8)])
	}

	plain, err := cloud.DecryptSnapshot(passphrase, up.body)
	if err != nil {
		t.Fatalf("decrypt snapshot: %v", err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(plain))
	if err != nil {
		t.Fatalf("snapshot is not gzip: %v", err)
	}
	raw, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	snapshotPath := filepath.Join(t.TempDir(), "sprint-5.sqlite")
	if err := os.WriteFile(snapshotPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := sql.Open("sqlite", snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	var done, events int
	if err := snapshot.QueryRow(`SELECT COUNT(*) FROM tasks WHERE thread = ? AND state = 'done'`, thread).Scan(&done); err != nil {
		t.Fatalf("query snapshot tasks: %v", err)
	}
	if done != 4 {
		t.Fatalf("want all four tasks done in the snapshot, got %d", done)
	}
	if err := snapshot.QueryRow(`SELECT COUNT(*) FROM events WHERE thread = ?`, thread).Scan(&events); err != nil {
		t.Fatalf("query snapshot events: %v", err)
	}
	if events < 5 {
		t.Fatalf("snapshot is missing sprint events: %d", events)
	}
}
