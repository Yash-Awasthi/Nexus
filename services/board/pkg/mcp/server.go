// Package mcp is a scratch-built Model Context Protocol server over stdio:
// newline-delimited JSON-RPC 2.0, no SDK, no Node runtime.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"open-board/pkg/slice"
)

// Client talks to a running broker.
type Client struct {
	BaseURL string
	Channel string
	HTTP    *http.Client
}

// NewClient returns a client for the broker at base.
func NewClient(base, channel string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(base, "/"),
		Channel: channel,
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) call(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	u := c.BaseURL + path
	if c.Channel != "" && !strings.Contains(path, "channel=") {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		u += sep + "channel=" + c.Channel
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("broker is not reachable at %s: %w", c.BaseURL, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			return fmt.Errorf("%s", e.Error)
		}
		return fmt.Errorf("%s answered %s", path, resp.Status)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Serve reads JSON-RPC messages from in and writes responses to out until in
// is exhausted or ctx is cancelled.
func Serve(ctx context.Context, in io.Reader, out io.Writer, c *Client) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	enc := json.NewEncoder(out)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
				Error: &rpcError{Code: -32700, Message: "parse error: " + err.Error()}})
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Notifications get no response.
		if len(req.ID) == 0 || string(req.ID) == "null" {
			continue
		}

		resp := handle(ctx, c, req)
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func handle(ctx context.Context, c *Client, req rpcRequest) rpcResponse {
	var result any
	var rerr *rpcError

	switch req.Method {
	case "initialize":
		result = map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "open-board", "version": "1.0.0"},
		}
	case "ping", "notifications/initialized":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": toolDefinitions()}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			rerr = &rpcError{Code: -32602, Message: "invalid params: " + err.Error()}
			break
		}
		text, err := callTool(ctx, c, params.Name, params.Arguments)
		if err != nil {
			result = map[string]any{
				"content": []map[string]string{{"type": "text", "text": "error: " + err.Error()}},
				"isError": true,
			}
			break
		}
		result = map[string]any{"content": []map[string]string{{"type": "text", "text": text}}}
	default:
		rerr = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
	}

	if rerr != nil {
		return rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: rerr}
	}
	return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result}
}

func toolDefinitions() []map[string]any {
	tool := func(name, description string, props map[string]any, required ...string) map[string]any {
		if required == nil {
			required = []string{}
		}
		return map[string]any{
			"name":        name,
			"description": description,
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": props,
				"required":   required,
			},
		}
	}
	str := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
	num := func(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }
	boolean := func(desc string) map[string]any { return map[string]any{"type": "boolean", "description": desc} }

	return []map[string]any{
		tool("board_post", "Post a message to a board thread. Prefix it with a status verb (claim:, working:, done:, stuck:, help:, failed:, lock:, unlock:, review-ok:, review-fail:, ask:, reply:) or send plain prose. 200-word cap.",
			map[string]any{
				"thread":  str("Thread (sprint) name"),
				"message": str("Message text"),
				"actor":   str("Who you are, e.g. claude"),
			}, "thread", "message"),
		tool("board_tail", "Read a thread's messages after a message id.",
			map[string]any{
				"thread": str("Thread name"),
				"after":  num("Return messages newer than this id (0 for the start)"),
				"limit":  num("Maximum messages (default 100)"),
			}, "thread"),
		tool("board_inbox", "Read messages that mention you (or @all) after your cursor, optionally without advancing it.",
			map[string]any{
				"agent":  str("Your agent name"),
				"thread": str("Thread name"),
				"peek":   boolean("Read without advancing your cursor"),
			}, "agent", "thread"),
		tool("board_threads", "List the board's threads with their message counts.",
			map[string]any{}, "thread"),
		tool("board_agents", "List the agents registered on the board and their states.",
			map[string]any{}),
		tool("board_tasks", "List tasks and their states, optionally filtered by thread or state.",
			map[string]any{
				"thread": str("Thread name"),
				"state":  str("queued, claimed, working, done or failed"),
			}),
		tool("board_claim", "Claim a task under a lease so no other agent can hold it.",
			map[string]any{
				"task_id": str("Task id"),
				"agent":   str("Your agent name"),
				"lease":   num("Lease in seconds (default 300, 30-3600)"),
			}, "task_id", "agent"),
		tool("board_done", "Complete a task you hold and post its done event.",
			map[string]any{
				"task_id": str("Task id"),
				"agent":   str("Your agent name"),
				"summary": str("What you changed"),
			}, "task_id", "agent"),
		tool("board_lock", "Take an exclusive file lock before editing a path.",
			map[string]any{
				"path":  str("Absolute or relative file path"),
				"task":  str("Task the edit belongs to"),
				"agent": str("Your agent name"),
			}, "path", "agent"),
		tool("board_unlock", "Release a file lock you hold.",
			map[string]any{
				"path":  str("File path"),
				"agent": str("Your agent name"),
				"force": boolean("Release any lock, as the human supervisor"),
			}, "path", "agent"),
		tool("board_slice", "Extract a slice of a file locally: line numbers (12-40) or a symbol name. Answers %*% requests without reading the whole file.",
			map[string]any{
				"path":   str("File path"),
				"target": str("Symbol name or line range such as 10-60"),
			}, "path"),
	}
}

func callTool(ctx context.Context, c *Client, name string, raw json.RawMessage) (string, error) {
	if c == nil {
		return "", fmt.Errorf("no broker configured")
	}
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	switch name {
	case "board_post":
		var args struct {
			Thread  string `json:"thread"`
			Message string `json:"message"`
			Actor   string `json:"actor"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		if args.Actor == "" {
			args.Actor = "claude"
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodPost, "/api/post", map[string]any{
			"channel": c.Channel, "thread": args.Thread, "actor": args.Actor, "content": args.Message,
		}, &out)
		return pretty(out), err
	case "board_tail":
		var args struct {
			Thread string `json:"thread"`
			After  int64  `json:"after"`
			Limit  int    `json:"limit"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		if args.Limit == 0 {
			args.Limit = 100
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodGet, fmt.Sprintf("/api/events?thread=%s&after=%d&limit=%d", args.Thread, args.After, args.Limit), nil, &out)
		return pretty(out), err
	case "board_inbox":
		var args struct {
			Agent  string `json:"agent"`
			Thread string `json:"thread"`
			Peek   bool   `json:"peek"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodGet, fmt.Sprintf("/api/inbox?agent=%s&thread=%s&peek=%t", args.Agent, args.Thread, args.Peek), nil, &out)
		return pretty(out), err
	case "board_threads":
		var out json.RawMessage
		err := c.call(ctx, http.MethodGet, "/api/threads", nil, &out)
		return pretty(out), err
	case "board_agents":
		var out json.RawMessage
		err := c.call(ctx, http.MethodGet, "/api/agents", nil, &out)
		return pretty(out), err
	case "board_tasks":
		var args struct {
			Thread string `json:"thread"`
			State  string `json:"state"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		path := "/api/tasks?"
		if args.Thread != "" {
			path += "thread=" + args.Thread + "&"
		}
		if args.State != "" {
			path += "state=" + args.State
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodGet, path, nil, &out)
		return pretty(out), err
	case "board_claim":
		var args struct {
			TaskID string `json:"task_id"`
			Agent  string `json:"agent"`
			Lease  int    `json:"lease"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodPost, "/api/claim", map[string]any{
			"channel": c.Channel, "task_id": args.TaskID, "agent": args.Agent, "lease": args.Lease,
		}, &out)
		return pretty(out), err
	case "board_done":
		var args struct {
			TaskID  string `json:"task_id"`
			Agent   string `json:"agent"`
			Summary string `json:"summary"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodPost, "/api/done", map[string]any{
			"channel": c.Channel, "task_id": args.TaskID, "agent": args.Agent, "summary": args.Summary,
		}, &out)
		return pretty(out), err
	case "board_lock":
		var args struct {
			Path  string `json:"path"`
			Task  string `json:"task"`
			Agent string `json:"agent"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodPost, "/api/locks", map[string]any{
			"channel": c.Channel, "path": args.Path, "task": args.Task, "agent": args.Agent,
		}, &out)
		return pretty(out), err
	case "board_unlock":
		var args struct {
			Path  string `json:"path"`
			Agent string `json:"agent"`
			Force bool   `json:"force"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		var out json.RawMessage
		err := c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/locks?path=%s&agent=%s&force=%t", args.Path, args.Agent, args.Force), nil, &out)
		return pretty(out), err
	case "board_slice":
		var args struct {
			Path   string `json:"path"`
			Target string `json:"target"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", err
		}
		return slice.Extract(args.Path, args.Target)
	default:
		return "", fmt.Errorf("unknown tool %q", name)
	}
}

func pretty(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "ok"
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return string(raw)
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return string(raw)
	}
	return string(data)
}
