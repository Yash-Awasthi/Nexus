package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"open-board/pkg/connectors"
)

func printConnectorUsage() {
	fmt.Print(`usage:
  vb connector list
  vb connector add <name> <command> [args...] [--preset rubrik] [--deny tool1,tool2]
  vb connector remove <name>
  vb connector tools <name>
  vb connector call <name> <tool> [json-arguments] [--thread <thread>] [--no-note]
  vb connector presets

A connector is any local MCP server (stdio) the board may call. Nothing starts
until a connector is configured and used. Examples:
  vb connector add rubrik --preset rubrik
  vb connector add files --preset filesystem
  vb connector add my-server npx -y my-mcp-server
`)
}

func cmdConnector(g global, args []string) int {
	if len(args) == 0 {
		printConnectorUsage()
		return 2
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "list", "ls":
		return connectorList(g)
	case "add":
		return connectorAdd(g, rest)
	case "remove", "rm", "delete":
		return connectorRemove(g, rest)
	case "tools":
		return connectorTools(g, rest)
	case "call":
		return connectorCall(g, rest)
	case "presets":
		return connectorPresets(g)
	case "help", "-h", "--help":
		printConnectorUsage()
		return 0
	default:
		return misuse("unknown connector command %q; try: vb connector list", sub)
	}
}

func connectorList(g global) int {
	c := newAPIClient(g)
	var out struct {
		Connectors []connectors.Status `json:"connectors"`
		Path       string              `json:"path"`
	}
	if err := c.do(http.MethodGet, "/api/connectors", nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	if len(out.Connectors) == 0 {
		fmt.Println("no connectors configured")
		fmt.Println("  add one:  vb connector add rubrik --preset rubrik")
		fmt.Println("  file:     " + out.Path)
		return 0
	}
	rows := make([][]string, 0, len(out.Connectors))
	for _, st := range out.Connectors {
		running := "idle"
		if st.Running {
			running = "running"
		}
		rows = append(rows, []string{st.Name, running, fmt.Sprint(st.Tools), st.Command})
	}
	printTable([]string{"name", "state", "tools", "command"}, rows)
	fmt.Println("\nfile: " + out.Path)
	return 0
}

func connectorAdd(g global, args []string) int {
	name := ""
	preset := ""
	deny := ""
	var command []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--preset" && i+1 < len(args):
			preset = args[i+1]
			i++
		case strings.HasPrefix(a, "--preset="):
			preset = strings.TrimPrefix(a, "--preset=")
		case a == "--deny" && i+1 < len(args):
			deny = args[i+1]
			i++
		case strings.HasPrefix(a, "--deny="):
			deny = strings.TrimPrefix(a, "--deny=")
		case name == "":
			name = a
		default:
			command = append(command, a)
		}
	}
	if name == "" {
		return misuse("usage: vb connector add <name> <command> [args...] [--preset <preset>]")
	}
	if len(command) == 0 && preset == "" {
		return misuse("give a command, or use --preset (" + strings.Join(connectors.PresetNames(), ", ") + ")")
	}
	body := map[string]any{"name": name, "preset": preset}
	if len(command) > 0 {
		body["command"] = command[0]
		body["args"] = command[1:]
	}
	if deny != "" {
		body["deny"] = splitList(deny)
	}
	c := newAPIClient(g)
	var out json.RawMessage
	if err := c.do(http.MethodPost, "/api/connectors", body, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Printf("added connector %s\n", name)
	fmt.Printf("  try: vb connector tools %s\n", name)
	return 0
}

func connectorRemove(g global, args []string) int {
	if len(args) != 1 {
		return misuse("usage: vb connector remove <name>")
	}
	c := newAPIClient(g)
	if err := c.do(http.MethodDelete, "/api/connectors?name="+url.QueryEscape(args[0]), nil, nil); err != nil {
		return fail(err)
	}
	fmt.Printf("removed connector %s\n", args[0])
	return 0
}

func connectorTools(g global, args []string) int {
	if len(args) != 1 {
		return misuse("usage: vb connector tools <name>")
	}
	c := newAPIClient(g)
	var out struct {
		Connector string            `json:"connector"`
		Tools     []connectors.Tool `json:"tools"`
	}
	if err := c.do(http.MethodGet, "/api/connectors/tools?name="+url.QueryEscape(args[0]), nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	if len(out.Tools) == 0 {
		fmt.Printf("%s exposes no tools\n", out.Connector)
		return 0
	}
	rows := make([][]string, 0, len(out.Tools))
	for _, t := range out.Tools {
		rows = append(rows, []string{t.Name, firstLine(t.Description)})
	}
	printTable([]string{"tool", "description"}, rows)
	return 0
}

func connectorCall(g global, args []string) int {
	name, tool, raw := "", "", ""
	thread := ""
	note := true
	var payload []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--thread" && i+1 < len(args):
			thread = args[i+1]
			i++
		case strings.HasPrefix(a, "--thread="):
			thread = strings.TrimPrefix(a, "--thread=")
		case a == "--no-note":
			note = false
		case name == "":
			name = a
		case tool == "":
			tool = a
		default:
			payload = append(payload, a)
		}
	}
	if name == "" || tool == "" {
		return misuse("usage: vb connector call <name> <tool> [json-arguments] [--thread <thread>]")
	}
	if len(payload) > 0 {
		raw = strings.Join(payload, " ")
	}
	var arguments map[string]any
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &arguments); err != nil {
			return misuse("arguments must be a JSON object: %v", err)
		}
	}
	body := map[string]any{
		"channel": g.channel, "thread": thread, "connector": name,
		"tool": tool, "arguments": arguments, "note": note,
	}
	c := newAPIClient(g)
	var out struct {
		Result connectors.Result `json:"result"`
	}
	if err := c.do(http.MethodPost, "/api/connectors/call", body, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	fmt.Print(out.Result.Text)
	if !strings.HasSuffix(out.Result.Text, "\n") {
		fmt.Println()
	}
	if thread != "" && note {
		fmt.Printf("\nnoted on %s/%s\n", g.channel, thread)
	}
	return 0
}

func connectorPresets(g global) int {
	c := newAPIClient(g)
	var out struct {
		Presets []connectors.Preset `json:"presets"`
	}
	if err := c.do(http.MethodGet, "/api/connectors/presets", nil, &out); err != nil {
		return fail(err)
	}
	if g.json {
		return printJSON(out)
	}
	for _, p := range out.Presets {
		fmt.Printf("%-12s %s\n", p.Name, p.Description)
	}
	return 0
}

func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 90 {
		s = s[:87] + "…"
	}
	return s
}
