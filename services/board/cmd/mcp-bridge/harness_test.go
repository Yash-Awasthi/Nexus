package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"open-board/pkg/api"
)

// TestMCPBridgeStdioConformance builds the bridge, spawns it as Claude Desktop
// would, and drives the real JSON-RPC 2.0 handshake over stdin/stdout against a
// live broker.
func TestMCPBridgeStdioConformance(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "mcp-bridge")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	build := exec.Command("go", "build", "-o", exe, ".")
	build.Env = os.Environ()
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build bridge: %v\n%s", err, out)
	}

	store, err := api.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(api.NewServer(store, "default").Handler(nil))
	defer func() {
		ts.Close()
		store.Close()
	}()

	sample := filepath.Join(t.TempDir(), "sample.go")
	if err := os.WriteFile(sample, []byte("package sample\n\nfunc Open() error {\n\treturn nil\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	bridge := exec.Command(exe)
	bridge.Env = append(os.Environ(), "VB_URL="+ts.URL, "VB_CHANNEL=default")
	stdin, err := bridge.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := bridge.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	bridge.Stderr = &stderr
	if err := bridge.Start(); err != nil {
		t.Fatalf("start bridge: %v", err)
	}
	waited := false
	defer func() {
		if !waited {
			bridge.Process.Kill()
			bridge.Wait()
		}
	}()

	enc := json.NewEncoder(stdin)
	dec := json.NewDecoder(stdout)
	nextID := 1
	call := func(method string, params any) (map[string]any, time.Duration) {
		t.Helper()
		id := nextID
		nextID++
		req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
		if params != nil {
			req["params"] = params
		}
		start := time.Now()
		if err := enc.Encode(req); err != nil {
			t.Fatalf("encode %s: %v", method, err)
		}
		var resp map[string]any
		if err := dec.Decode(&resp); err != nil {
			t.Fatalf("decode %s: %v (stderr: %s)", method, err, stderr.String())
		}
		elapsed := time.Since(start)
		if resp["jsonrpc"] != "2.0" {
			t.Fatalf("%s: jsonrpc = %v", method, resp["jsonrpc"])
		}
		if got, ok := resp["id"].(float64); !ok || int(got) != id {
			t.Fatalf("%s: id = %v, want %d", method, resp["id"], id)
		}
		if rpcErr, ok := resp["error"]; ok {
			t.Fatalf("%s: %v", method, rpcErr)
		}
		return resp, elapsed
	}

	init, _ := call("initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "harness", "version": "1.0"},
	})
	initResult := init["result"].(map[string]any)
	if initResult["protocolVersion"] != "2024-11-05" {
		t.Fatalf("unexpected initialize result: %v", initResult)
	}
	info := initResult["serverInfo"].(map[string]any)
	if info["name"] != "open-board" {
		t.Fatalf("unexpected serverInfo: %v", info)
	}

	if err := enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		t.Fatal(err)
	}

	list, _ := call("tools/list", map[string]any{})
	tools := list["result"].(map[string]any)["tools"].([]any)
	names := map[string]bool{}
	for _, raw := range tools {
		names[raw.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"board_inbox", "board_post", "board_slice"} {
		if !names[want] {
			t.Fatalf("tools/list is missing %s: %v", want, names)
		}
	}

	callTool := func(name string, args map[string]any) (string, bool, time.Duration) {
		t.Helper()
		resp, elapsed := call("tools/call", map[string]any{"name": name, "arguments": args})
		result := resp["result"].(map[string]any)
		content := result["content"].([]any)
		if len(content) == 0 {
			t.Fatalf("%s returned no content: %v", name, result)
		}
		text := content[0].(map[string]any)["text"].(string)
		isError, _ := result["isError"].(bool)
		return text, isError, elapsed
	}

	// Warm the HTTP path and the file cache so the measured calls exclude
	// first-connection and first-read setup.
	if text, isErr, _ := callTool("board_agents", map[string]any{}); isErr {
		t.Fatalf("warm-up board_agents failed: %s", text)
	}
	if text, isErr, _ := callTool("board_slice", map[string]any{"path": sample, "target": "func Open"}); isErr {
		t.Fatalf("warm-up board_slice failed: %s", text)
	}

	posted, isErr, postLatency := callTool("board_post", map[string]any{
		"thread": "sprint-5", "message": "@claude bridge hello", "actor": "claude-desktop",
	})
	if isErr || !strings.Contains(posted, "bridge hello") {
		t.Fatalf("board_post failed: %s", posted)
	}

	inbox, isErr, inboxLatency := callTool("board_inbox", map[string]any{
		"agent": "claude", "thread": "sprint-5",
	})
	if isErr || !strings.Contains(inbox, "bridge hello") {
		t.Fatalf("board_inbox did not return the mention: %s", inbox)
	}

	code, isErr, sliceLatency := callTool("board_slice", map[string]any{
		"path": sample, "target": "func Open",
	})
	if isErr || !strings.Contains(code, "```go") || !strings.Contains(code, "func Open(") {
		t.Fatalf("board_slice did not return the symbol: %s", code)
	}

	if !raceEnabled {
		for name, latency := range map[string]time.Duration{
			"board_post": postLatency, "board_inbox": inboxLatency, "board_slice": sliceLatency,
		} {
			if latency >= 2*time.Millisecond {
				t.Fatalf("%s round trip took %s, want < 2ms", name, latency)
			}
		}
	}

	stdin.Close()
	wait := make(chan error, 1)
	go func() { wait <- bridge.Wait() }()
	select {
	case err := <-wait:
		waited = true
		if err != nil {
			t.Fatalf("bridge exited with %v (stderr: %s)", err, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("bridge did not exit after stdin closed (stderr: %s)", stderr.String())
	}

	// A closed pipe is a clean end for the stdio server: it must not print
	// protocol noise there.
	if strings.Contains(stderr.String(), "panic") {
		t.Fatalf("bridge stderr contains a panic: %s", stderr.String())
	}
}
