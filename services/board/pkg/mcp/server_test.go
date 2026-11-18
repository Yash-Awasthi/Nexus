package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"open-board/pkg/mcp"
)

func fakeBroker(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/post"):
			if r.Method != http.MethodPost {
				t.Errorf("post used %s", r.Method)
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["content"] != "done: T1 shipped" {
				t.Errorf("unexpected content: %v", body["content"])
			}
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"event":{"id":7,"thread":"s","actor_id":"claude","content":"done: T1 shipped"},"warnings":[]}`))
		case r.URL.Path == "/api/agents":
			w.Write([]byte(`{"agents":[{"name":"claude","state":"idle"}]}`))
		case r.URL.Path == "/api/tasks":
			w.Write([]byte(`{"tasks":[]}`))
		default:
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func serve(t *testing.T, broker string, lines ...string) []map[string]any {
	t.Helper()
	in := strings.NewReader(strings.Join(lines, "\n") + "\n")
	var out bytes.Buffer
	if err := mcp.Serve(context.Background(), in, &out, mcp.NewClient(broker, "default")); err != nil {
		t.Fatal(err)
	}
	var responses []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad response line %q: %v", line, err)
		}
		responses = append(responses, m)
	}
	return responses
}

func TestInitializeAndToolsList(t *testing.T) {
	broker := fakeBroker(t)
	responses := serve(t, broker.URL,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	)
	if len(responses) != 2 {
		t.Fatalf("notifications must not be answered: %d responses", len(responses))
	}
	init := responses[0]["result"].(map[string]any)
	if init["protocolVersion"] != "2024-11-05" {
		t.Fatalf("unexpected initialize: %v", init)
	}
	tools := responses[1]["result"].(map[string]any)["tools"].([]any)
	if len(tools) < 10 {
		t.Fatalf("expected the full tool set, got %d", len(tools))
	}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		if tool["name"] == "" || tool["inputSchema"] == nil {
			t.Fatalf("incomplete tool: %v", tool)
		}
	}
}

func TestToolsCall(t *testing.T) {
	broker := fakeBroker(t)
	responses := serve(t, broker.URL,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"board_post","arguments":{"thread":"s","message":"done: T1 shipped","actor":"claude"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"board_agents","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope","arguments":{}}}`,
	)
	if len(responses) != 3 {
		t.Fatalf("want 3 responses, got %d", len(responses))
	}
	result := responses[0]["result"].(map[string]any)
	content := result["content"].([]any)[0].(map[string]any)
	if !strings.Contains(content["text"].(string), "\"id\": 7") {
		t.Fatalf("post result was not returned: %v", content)
	}
	if result["isError"] == true {
		t.Fatalf("post should not be an error: %v", result)
	}

	agents := responses[1]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)
	if !strings.Contains(agents["text"].(string), "claude") {
		t.Fatalf("agents result was not returned: %v", agents)
	}

	unknown := responses[2]["result"].(map[string]any)
	if unknown["isError"] != true {
		t.Fatalf("an unknown tool should be a tool error: %v", unknown)
	}
}

func TestUnknownMethodAndBadJSON(t *testing.T) {
	broker := fakeBroker(t)
	responses := serve(t, broker.URL,
		`{"jsonrpc":"2.0","id":1,"method":"does/not/exist"}`,
		`{not json}`,
	)
	if len(responses) != 2 {
		t.Fatalf("want 2 responses, got %d", len(responses))
	}
	err1 := responses[0]["error"].(map[string]any)
	if err1["code"].(float64) != -32601 {
		t.Fatalf("unexpected error: %v", err1)
	}
	err2 := responses[1]["error"].(map[string]any)
	if err2["code"].(float64) != -32700 {
		t.Fatalf("unexpected parse error: %v", err2)
	}
}
