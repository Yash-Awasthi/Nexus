// Command mcp-bridge is the Claude Desktop stdio bridge: a zero-dependency
// JSON-RPC 2.0 server that exposes the board's tools over stdin/stdout.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"time"

	"open-board/pkg/mcp"
)

func main() {
	server := os.Getenv("VB_URL")
	if server == "" {
		server = "http://127.0.0.1:4100"
	}
	channel := os.Getenv("VB_CHANNEL")
	if channel == "" {
		channel = "default"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	// A write from this bridge is a model acting on a shared board. Two steps by default: the
	// first call reports what it would change, and the call only lands when it comes back with
	// the token. OPEN_BOARD_MCP_READ_ONLY=1 refuses writes outright, for a server that should
	// only ever observe.
	opts := mcp.Options{
		Approval: mcp.NewApproval(5 * time.Minute),
		ReadOnly: os.Getenv("OPEN_BOARD_MCP_READ_ONLY") == "1",
	}

	if err := mcp.ServeWith(ctx, os.Stdin, os.Stdout, mcp.NewClient(server, channel), opts); err != nil {
		fmt.Fprintln(os.Stderr, "mcp-bridge:", err)
		os.Exit(1)
	}
}
