package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"open-board/pkg/mcp"
)

// A write through the bridge is two calls, and the point of the second one is that the first did
// nothing. So the tests count what reached the broker: `posts` must be 0 after a challenged call,
// and 1 after the approved repeat.

type countingBroker struct {
	server *httptest.Server
	posts  atomic.Int32
}

func newCountingBroker(t *testing.T) *countingBroker {
	t.Helper()
	broker := &countingBroker{}
	broker.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/post"):
			broker.posts.Add(1)
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"event":{"id":1,"content":"done"}}`))
		case r.URL.Path == "/api/tasks":
			w.Write([]byte(`{"tasks":[]}`))
		default:
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		}
	}))
	t.Cleanup(broker.server.Close)
	return broker
}

// serveWith runs JSON-RPC lines through ServeWith and returns the tool result text of each call.
func serveWith(t *testing.T, broker string, opts mcp.Options, arguments ...map[string]any) []string {
	t.Helper()
	lines := make([]string, 0, len(arguments))
	for i, args := range arguments {
		payload, err := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      i + 1,
			"method":  "tools/call",
			"params":  map[string]any{"name": "board_post", "arguments": args},
		})
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, string(payload))
	}

	var out bytes.Buffer
	if err := mcp.ServeWith(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n"),
		&out, mcp.NewClient(broker, "default"), opts); err != nil {
		t.Fatal(err)
	}

	var texts []string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var response struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			t.Fatalf("bad response %q: %v", line, err)
		}
		text := ""
		if len(response.Result.Content) > 0 {
			text = response.Result.Content[0].Text
		}
		texts = append(texts, text)
	}
	return texts
}

func TestAWriteIsNotPerformedUntilItIsApproved(t *testing.T) {
	broker := newCountingBroker(t)
	opts := mcp.Options{Approval: mcp.NewApproval(time.Minute)}

	challenge := serveWith(t, broker.server.URL, opts, map[string]any{
		"thread": "sprint-6", "message": "done: T1", "actor": "claude",
	})
	if len(challenge) != 1 {
		t.Fatalf("want one response, got %d", len(challenge))
	}
	if broker.posts.Load() != 0 {
		t.Fatalf("the challenged call reached the broker %d times", broker.posts.Load())
	}

	var asked struct {
		ApprovalRequired bool           `json:"approval_required"`
		Tool             string         `json:"tool"`
		Arguments        map[string]any `json:"arguments"`
		Confirm          string         `json:"confirm"`
		Expires          int            `json:"expires_in_seconds"`
	}
	if err := json.Unmarshal([]byte(challenge[0]), &asked); err != nil {
		t.Fatalf("the challenge is not JSON (%v): %s", err, challenge[0])
	}
	if !asked.ApprovalRequired || asked.Tool != "board_post" || asked.Confirm == "" {
		t.Fatalf("unexpected challenge: %s", challenge[0])
	}
	// The person approving it sees what will happen, not just a token.
	if asked.Arguments["message"] != "done: T1" {
		t.Fatalf("challenge did not echo the action: %v", asked.Arguments)
	}
	if asked.Expires != 60 {
		t.Fatalf("want a 60s window, got %d", asked.Expires)
	}

	approved := serveWith(t, broker.server.URL, opts, map[string]any{
		"thread": "sprint-6", "message": "done: T1", "actor": "claude", "confirm": asked.Confirm,
	})
	if broker.posts.Load() != 1 {
		t.Fatalf("the approved call reached the broker %d times", broker.posts.Load())
	}
	if strings.Contains(approved[0], "approval_required") {
		t.Fatalf("the approved call was challenged again: %s", approved[0])
	}
}

func TestAnApprovalTokenIsSingleUseAndBoundToItsArguments(t *testing.T) {
	broker := newCountingBroker(t)
	opts := mcp.Options{Approval: mcp.NewApproval(time.Minute)}

	first := serveWith(t, broker.server.URL, opts, map[string]any{"thread": "s", "message": "one"})
	var asked struct {
		Confirm string `json:"confirm"`
	}
	if err := json.Unmarshal([]byte(first[0]), &asked); err != nil {
		t.Fatal(err)
	}

	// Same token, different message: the token was issued for the first arguments only.
	swapped := serveWith(t, broker.server.URL, opts,
		map[string]any{"thread": "s", "message": "two", "confirm": asked.Confirm})
	if broker.posts.Load() != 0 {
		t.Fatalf("a token for one message authorised another (%d posts)", broker.posts.Load())
	}
	if !strings.Contains(swapped[0], "error") {
		t.Fatalf("a reused token was accepted: %s", swapped[0])
	}

	// Correct use succeeds once...
	serveWith(t, broker.server.URL, opts,
		map[string]any{"thread": "s", "message": "one", "confirm": asked.Confirm})
	if broker.posts.Load() != 1 {
		t.Fatalf("want 1 post, got %d", broker.posts.Load())
	}
	// ...and the same token cannot be replayed.
	again := serveWith(t, broker.server.URL, opts,
		map[string]any{"thread": "s", "message": "one", "confirm": asked.Confirm})
	if broker.posts.Load() != 1 {
		t.Fatalf("a token was replayed: %d posts", broker.posts.Load())
	}
	if !strings.Contains(again[0], "error") {
		t.Fatalf("the replay was accepted: %s", again[0])
	}
}

func TestAnExpiredTokenIsRefused(t *testing.T) {
	broker := newCountingBroker(t)
	approval := mcp.NewApproval(time.Nanosecond)
	opts := mcp.Options{Approval: approval}

	token := approval.Issue("board_post", json.RawMessage(`{"thread":"s","message":"late"}`))
	time.Sleep(2 * time.Millisecond)
	if broke := approval.Consume("board_post", json.RawMessage(`{"thread":"s","message":"late"}`), token); broke {
		t.Fatal("an expired token was accepted")
	}
	text := serveWith(t, broker.server.URL, opts,
		map[string]any{"thread": "s", "message": "late", "confirm": token})
	if broker.posts.Load() != 0 {
		t.Fatalf("an expired token authorised a write: %d posts", broker.posts.Load())
	}
	if !strings.Contains(text[0], "error") {
		t.Fatalf("an expired token was accepted: %s", text[0])
	}
}

func TestReadsNeverNeedApproval(t *testing.T) {
	broker := newCountingBroker(t)
	opts := mcp.Options{Approval: mcp.NewApproval(time.Minute)}

	var out bytes.Buffer
	line := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"board_tasks","arguments":{}}}`
	if err := mcp.ServeWith(context.Background(), strings.NewReader(line+"\n"), &out,
		mcp.NewClient(broker.server.URL, "default"), opts); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "approval_required") {
		t.Fatalf("a read was challenged: %s", out.String())
	}
	if !strings.Contains(out.String(), "tasks") {
		t.Fatalf("a read did not reach the broker: %s", out.String())
	}
}

func TestAReadOnlyBridgeRefusesWritesBeforeAsking(t *testing.T) {
	broker := newCountingBroker(t)
	opts := mcp.Options{Approval: mcp.NewApproval(time.Minute), ReadOnly: true}

	text := serveWith(t, broker.server.URL, opts, map[string]any{"thread": "s", "message": "hi"})
	if broker.posts.Load() != 0 {
		t.Fatalf("a read-only bridge posted")
	}
	if !strings.Contains(text[0], "read-only") {
		t.Fatalf("want a read-only refusal, got: %s", text[0])
	}
}

func TestTheSchemaTellsAClientWhichToolsWrite(t *testing.T) {
	var out bytes.Buffer
	if err := mcp.ServeWith(context.Background(), strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`+"\n"), &out, nil, mcp.Options{}); err != nil {
		t.Fatal(err)
	}

	var response struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				InputSchema struct {
					Properties map[string]any `json:"properties"`
				} `json:"inputSchema"`
				Annotations struct {
					ReadOnlyHint    bool `json:"readOnlyHint"`
					DestructiveHint bool `json:"destructiveHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Result.Tools) < 9 {
		t.Fatalf("only %d tools listed", len(response.Result.Tools))
	}
	for _, tool := range response.Result.Tools {
		if mcp.IsWrite(tool.Name) {
			if _, ok := tool.InputSchema.Properties["confirm"]; !ok {
				t.Errorf("%s writes but has no confirm argument in its schema", tool.Name)
			}
			if tool.Annotations.ReadOnlyHint || !tool.Annotations.DestructiveHint {
				t.Errorf("%s writes but is not annotated as such", tool.Name)
			}
			continue
		}
		if !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint {
			t.Errorf("%s only reads but is annotated as a write", tool.Name)
		}
		if _, ok := tool.InputSchema.Properties["confirm"]; ok {
			t.Errorf("%s only reads but accepts a confirm argument", tool.Name)
		}
	}
}

func TestEveryWriteToolIsInTheList(t *testing.T) {
	// The list is the policy, so a write tool that is not in it would be a hole.
	for _, name := range []string{"board_post", "board_claim", "board_done", "board_lock", "board_unlock"} {
		if !mcp.IsWrite(name) {
			t.Errorf("%s changes the board but IsWrite says it does not", name)
		}
	}
	for _, name := range []string{"board_tail", "board_inbox", "board_threads", "board_agents", "board_tasks", "board_slice"} {
		if mcp.IsWrite(name) {
			t.Errorf("%s only reads but is treated as a write", name)
		}
	}
}

func TestPendingTokensAreBounded(t *testing.T) {
	approval := mcp.NewApproval(time.Minute)
	for i := 0; i < 400; i++ {
		message := json.RawMessage(`{"message":"m` + string(rune('a'+i%26)) + `"}`)
		approval.Issue("board_post", message)
	}
	if pending := approval.Pending(); pending > 256 {
		t.Fatalf("pending tokens grew to %d; the cap is 256", pending)
	}
}
