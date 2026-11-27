// Package connectors runs optional local MCP servers ("connectors") and calls
// their tools. Nothing starts until a connector is configured and used.
package connectors

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const protocolVersion = "2024-11-05"

var errClosed = errors.New("connector is closed")

// Tool is one tool advertised by a connector's tools/list.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// client is one child process speaking MCP over stdio.
type client struct {
	name   string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	out    *bufio.Reader
	stderr *tailBuffer
	mu     sync.Mutex
	nextID int64
	closed bool
}

func startClient(ctx context.Context, name string, c Connector, version string) (*client, error) {
	command, args := c.Command, append([]string(nil), c.Args...)
	if runtime.GOOS == "windows" {
		// npx, npm and friends are .cmd shims, which CreateProcess cannot run
		// directly; go through the command processor for those.
		switch strings.ToLower(filepath.Ext(command)) {
		case ".cmd", ".bat":
			args = append([]string{"/c", command}, args...)
			command = "cmd.exe"
		}
	}
	cmd := exec.Command(command, args...)
	cmd.Env = os.Environ()
	for _, key := range sortedKeys(c.Env) {
		cmd.Env = append(cmd.Env, key+"="+c.Env[key])
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("connector %q: stdin: %w", name, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("connector %q: stdout: %w", name, err)
	}
	tail := &tailBuffer{max: 4096}
	cmd.Stderr = tail
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("connector %q: cannot start %q: %w (install it, or fix the command in connectors.json)", name, c.label(), err)
	}

	cl := &client{name: name, cmd: cmd, stdin: stdin, out: bufio.NewReaderSize(stdout, 1<<20), stderr: tail}
	// A cold start is not a stuck start: `npx -y` and `uvx` may download the server on the
	// first run, which routinely takes longer than a protocol handshake. One minute covers a
	// cold package fetch; after this the server is warm and later calls answer in milliseconds.
	initCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	_, err = cl.request(initCtx, "initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "open-board", "version": version},
	})
	if err != nil {
		cl.Close()
		return nil, fmt.Errorf("connector %q (%s): handshake failed: %v%s", name, c.label(), err, tail.suffix())
	}
	_ = cl.notify("notifications/initialized", map[string]any{})
	return cl, nil
}

func (c *client) notify(method string, params any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errClosed
	}
	return c.writeLocked(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *client) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errClosed
	}
	c.nextID++
	id := c.nextID
	msg := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := c.writeLocked(msg); err != nil {
		return nil, err
	}

	type outcome struct {
		result json.RawMessage
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		for {
			line, err := c.out.ReadBytes('\n')
			line = bytes.TrimSpace(line)
			if len(line) > 0 {
				var m rpcMessage
				if json.Unmarshal(line, &m) == nil && len(m.ID) > 0 && string(m.ID) != "null" {
					var got int64
					if json.Unmarshal(m.ID, &got) == nil && got == id {
						if m.Error != nil {
							done <- outcome{err: fmt.Errorf("%s", m.Error.Message)}
							return
						}
						done <- outcome{result: m.Result}
						return
					}
				}
			}
			if err != nil {
				done <- outcome{err: fmt.Errorf("connector %q stopped: %v", c.name, err)}
				return
			}
		}
	}()

	select {
	case o := <-done:
		return o.result, o.err
	case <-ctx.Done():
		c.killLocked()
		return nil, fmt.Errorf("%s: %w", method, ctx.Err())
	}
}

func (c *client) writeLocked(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := c.stdin.Write(data); err != nil {
		return fmt.Errorf("connector %q closed its input: %w", c.name, err)
	}
	return nil
}

func (c *client) killLocked() {
	if c.closed {
		return
	}
	c.closed = true
	_ = c.stdin.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}

// Close stops the child process.
func (c *client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	c.mu.Lock()
	c.killLocked()
	c.mu.Unlock()

	done := make(chan struct{})
	go func() {
		_ = c.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		<-done
	}
	return nil
}

// ListTools asks the child which tools it exposes.
func (c *client) ListTools(ctx context.Context) ([]Tool, error) {
	raw, err := c.request(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var body struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("connector %q: tools/list: %w", c.name, err)
	}
	return body.Tools, nil
}

// CallTool invokes one tool and returns its text content.
func (c *client) CallTool(ctx context.Context, tool string, args map[string]any) (string, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.request(ctx, "tools/call", map[string]any{"name": tool, "arguments": args})
	if err != nil {
		return "", err
	}
	var body struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", fmt.Errorf("connector %q: tools/call %s: %w", c.name, tool, err)
	}
	parts := make([]string, 0, len(body.Content))
	for _, item := range body.Content {
		if item.Text != "" {
			parts = append(parts, item.Text)
		}
	}
	text := strings.Join(parts, "\n")
	if body.IsError {
		if text == "" {
			text = "the connector reported an error"
		}
		return "", errors.New(text)
	}
	return text, nil
}

// tailBuffer keeps the last bytes of a child's stderr so a failure can quote it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) suffix() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	text := strings.TrimSpace(string(t.buf))
	if text == "" {
		return ""
	}
	if i := strings.LastIndexByte(text, '\n'); i >= 0 {
		text = text[i+1:]
	}
	return " (" + text + ")"
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
