package connectors

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestConnectorHelperProcess is a stub MCP server. It is only active when the
// test binary is started as a child with GO_CONNECTOR_HELPER=1.
func TestConnectorHelperProcess(t *testing.T) {
	if os.Getenv("GO_CONNECTOR_HELPER") != "1" {
		return
	}
	enc := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		reply := func(result any) {
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
		}
		switch msg.Method {
		case "initialize":
			reply(map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "stub", "version": "1"},
			})
		case "notifications/initialized":
			// notifications get no reply
		case "tools/list":
			reply(map[string]any{"tools": []map[string]any{
				{"name": "echo", "description": "echo text back", "inputSchema": map[string]any{"type": "object"}},
				{"name": "fail", "description": "always fails", "inputSchema": map[string]any{"type": "object"}},
				{"name": "slow", "description": "sleeps", "inputSchema": map[string]any{"type": "object"}},
			}})
		case "tools/call":
			var p struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(msg.Params, &p)
			switch p.Name {
			case "echo":
				text, _ := p.Arguments["text"].(string)
				reply(map[string]any{"content": []map[string]string{{"type": "text", "text": text}}})
			case "fail":
				reply(map[string]any{
					"content": []map[string]string{{"type": "text", "text": "stub refused"}},
					"isError": true,
				})
			case "slow":
				time.Sleep(2 * time.Second)
				reply(map[string]any{"content": []map[string]string{{"type": "text", "text": "late"}}})
			default:
				_ = enc.Encode(map[string]any{
					"jsonrpc": "2.0", "id": msg.ID,
					"error": map[string]any{"code": -32601, "message": "no such tool"},
				})
			}
		}
	}
	os.Exit(0)
}

func stubConnector() Connector {
	return Connector{
		Command: os.Args[0],
		Args:    []string{"-test.run=TestConnectorHelperProcess"},
		Env:     map[string]string{"GO_CONNECTOR_HELPER": "1"},
	}
}

func newTestManager(t *testing.T, c Connector) *Manager {
	t.Helper()
	dir := t.TempDir()
	m, err := NewManager(filepath.Join(dir, "connectors.json"), "test", nil)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(m.Close)
	if err := m.Add("stub", c); err != nil {
		t.Fatalf("Add: %v", err)
	}
	return m
}

func TestCallAndListTools(t *testing.T) {
	m := newTestManager(t, stubConnector())
	ctx := context.Background()

	tools, err := m.Tools(ctx, "stub")
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(tools))
	}

	res, err := m.Call(ctx, "stub", "echo", map[string]any{"text": "hello board"})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if res.Text != "hello board" {
		t.Fatalf("unexpected text %q", res.Text)
	}
	if res.Connector != "stub" || res.Tool != "echo" {
		t.Fatalf("unexpected result %+v", res)
	}

	status := m.List()
	if len(status) != 1 || !status[0].Running || status[0].Tools != 3 {
		t.Fatalf("unexpected status %+v", status)
	}
}

func TestUnknownToolIsRefusedWithTheList(t *testing.T) {
	m := newTestManager(t, stubConnector())
	_, err := m.Call(context.Background(), "stub", "rsc_delete_everything", nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "does not expose") || !strings.Contains(err.Error(), "echo") {
		t.Fatalf("error should name the tool and list available ones, got: %v", err)
	}
}

func TestDenyListWins(t *testing.T) {
	c := stubConnector()
	c.Deny = []string{"echo"}
	m := newTestManager(t, c)
	_, err := m.Call(context.Background(), "stub", "echo", map[string]any{"text": "x"})
	if err == nil || !strings.Contains(err.Error(), "deny") {
		t.Fatalf("expected a deny error, got %v", err)
	}
}

func TestToolReportedAsErrorBecomesAnError(t *testing.T) {
	m := newTestManager(t, stubConnector())
	if _, err := m.Call(context.Background(), "stub", "fail", nil); err == nil {
		t.Fatal("expected the tool's error to surface")
	}
}

func TestMissingConnectorSaysHowToAddOne(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(filepath.Join(dir, "connectors.json"), "test", nil)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer m.Close()
	if _, err := m.Tools(context.Background(), "rubrik"); err == nil || !strings.Contains(err.Error(), "vb connector add") {
		t.Fatalf("expected an actionable error, got %v", err)
	}
}

func TestMissingCommandFailsClearly(t *testing.T) {
	m := newTestManager(t, Connector{Command: "definitely-not-a-real-command-xyz"})
	_, err := m.Call(context.Background(), "stub", "echo", nil)
	if err == nil {
		t.Fatal("expected a start error")
	}
	if !strings.Contains(err.Error(), "cannot start") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCallTimeout(t *testing.T) {
	m := newTestManager(t, stubConnector())
	m.timeout = 150 * time.Millisecond
	_, err := m.Call(context.Background(), "stub", "slow", nil)
	if err == nil {
		t.Fatal("expected a timeout")
	}
	if !strings.Contains(err.Error(), "deadline") && !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestIdleSessionIsStopped(t *testing.T) {
	c := stubConnector()
	c.IdleSeconds = 1
	m := newTestManager(t, c)
	if _, err := m.Tools(context.Background(), "stub"); err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if !m.List()[0].Running {
		t.Fatal("expected the connector to be running")
	}
	time.Sleep(1100 * time.Millisecond)
	m.closeIdle()
	if m.List()[0].Running {
		t.Fatal("expected the idle connector to be stopped")
	}
}

func TestAddRemoveAndReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "connectors.json")
	m, err := NewManager(path, "test", nil)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer m.Close()
	if err := m.Add("demo", Connector{Command: "uvx", Args: []string{"demo-mcp"}}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("connectors.json was not written: %v", err)
	}
	again, err := NewManager(path, "test", nil)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	defer again.Close()
	if got := again.List(); len(got) != 1 || got[0].Command != "uvx demo-mcp" {
		t.Fatalf("unexpected list %+v", got)
	}
	if err := again.Remove("demo"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(again.List()) != 0 {
		t.Fatal("expected no connectors after remove")
	}
}

func TestInvalidConfigFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "connectors.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewManager(path, "test", nil); err == nil {
		t.Fatal("expected invalid JSON to be refused")
	}
}

func TestHelperProcessStartsForReal(t *testing.T) {
	// Guards the stub itself: if the helper process pattern breaks on this
	// platform, the other tests would fail confusingly.
	cmd := exec.Command(stubConnector().Command, stubConnector().Args...)
	cmd.Env = append(os.Environ(), "GO_CONNECTOR_HELPER=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = stdin.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatalf("helper did not exit cleanly: %v", err)
	}
}
