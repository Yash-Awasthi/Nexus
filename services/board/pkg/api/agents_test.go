package api_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"open-board/pkg/agents"
	"open-board/pkg/api"
)

// helperSupervisor installs a manifest that points back at this test binary,
// so the whole claim -> launch -> log -> done path runs without a real agent.
func helperSupervisor(t *testing.T, srv *api.Server) string {
	t.Helper()
	exe, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manifest := map[string]any{
		"id":   "helper",
		"name": "Supervisor Helper",
		"bin":  exe,
		"chat": map[string]any{
			"args": []string{"-test.run=TestAgentRunHelper", "--", "--agent-run-helper"},
		},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "helper.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	reg, _, err := agents.LoadRegistry(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv.Supervisor = agents.NewSupervisor(reg, srv.Store.Dir())
	return srv.Store.Dir()
}

func TestAgentRunClaimsExecutesAndCompletes(t *testing.T) {
	var storeDir string
	ts := newBoardWith(t, func(srv *api.Server) { storeDir = helperSupervisor(t, srv) })

	code, body := do(t, ts, http.MethodPost, "/api/tasks", map[string]any{
		"thread": "sprint-6", "title": "wire the doer", "contract": "agents.Supervisor",
	})
	if code != http.StatusCreated {
		t.Fatalf("create task: %d %v", code, body)
	}
	taskID := body["task"].(map[string]any)["id"].(string)

	code, body = do(t, ts, http.MethodPost, "/api/agents/run", map[string]any{
		"agent": "helper", "task_id": taskID,
	})
	if code != http.StatusAccepted {
		t.Fatalf("run: %d %v", code, body)
	}
	if pid, _ := body["pid"].(float64); pid <= 0 {
		t.Fatalf("run did not report a pid: %v", body)
	}
	prompt, _ := body["prompt"].(string)
	if !strings.Contains(prompt, taskID) || !strings.Contains(prompt, "agents.Supervisor") {
		t.Fatalf("the doer prompt is missing the task or contract: %q", prompt)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		code, body = do(t, ts, http.MethodGet, "/api/tasks/get?id="+taskID, nil)
		if code != http.StatusOK {
			t.Fatalf("get task: %d %v", code, body)
		}
		task := body["task"].(map[string]any)
		if task["state"] == "done" {
			if owner, _ := task["owner"].(string); owner != "helper" {
				t.Fatalf("done task lost its owner: %v", task)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task did not become done after a clean exit: %v", task)
		}
		time.Sleep(50 * time.Millisecond)
	}

	logPath := filepath.Join(storeDir, "default", "agents", "helper-supervisor.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read supervisor log: %v", err)
	}
	for _, want := range []string{"agent-run-helper-output", "exit code 0", "supervised doer for task " + taskID, "Interface contract: agents.Supervisor"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("supervisor log is missing %q:\n%s", want, data)
		}
	}

	code, body = do(t, ts, http.MethodGet, "/api/events?thread=sprint-6", nil)
	if code != http.StatusOK || !strings.Contains(fmt.Sprint(body["events"]), "done: "+taskID) {
		t.Fatalf("a completed run should post a done event: %d %v", code, body)
	}

	// The same log is served to the inspector as SSE, then closed.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/agents/logs?agent=helper&follow=0", nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	stream, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(stream), "event: log") || !strings.Contains(string(stream), "agent-run-helper-output") {
		t.Fatalf("log stream is missing the agent output: %q", stream)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("logs are not SSE: %q", ct)
	}

	code, _ = do(t, ts, http.MethodGet, "/api/agents/logs?agent=bad%20agent", nil)
	if code != http.StatusBadRequest {
		t.Fatalf("an invalid agent name should be a 400, got %d", code)
	}
}

func TestForceRequeueOverHTTP(t *testing.T) {
	ts := newBoard(t)
	_, body := do(t, ts, http.MethodPost, "/api/tasks", map[string]any{
		"thread": "s", "title": "stuck work", "contract": "locks.Manager",
	})
	taskID := body["task"].(map[string]any)["id"].(string)
	if code, body := do(t, ts, http.MethodPost, "/api/claim", map[string]any{
		"task_id": taskID, "agent": "stuck-agent",
	}); code != http.StatusOK {
		t.Fatalf("claim: %d %v", code, body)
	}

	code, body := do(t, ts, http.MethodPost, "/api/tasks/requeue", map[string]any{
		"task_id": taskID, "actor": "human",
	})
	if code != http.StatusOK {
		t.Fatalf("requeue: %d %v", code, body)
	}
	task := body["task"].(map[string]any)
	if task["state"] != "queued" || task["owner"] != nil || task["lease_until"] != nil {
		t.Fatalf("force requeue left work claimed: %v", task)
	}
	if task["contract_interface"] != "locks.Manager" {
		t.Fatalf("force requeue dropped the contract: %v", task)
	}

	code, _ = do(t, ts, http.MethodPost, "/api/tasks/requeue", map[string]any{"task_id": "missing"})
	if code != http.StatusNotFound {
		t.Fatalf("requeueing a missing task should be 404, got %d", code)
	}
}

// TestAgentRunHelper is the subprocess the broker launches in these tests.
func TestAgentRunHelper(t *testing.T) {
	for _, arg := range os.Args {
		if arg == "--agent-run-helper" {
			fmt.Println("agent-run-helper-output")
			os.Exit(0)
		}
	}
}
