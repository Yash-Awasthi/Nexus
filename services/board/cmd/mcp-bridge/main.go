// Command mcp-bridge is the Claude Desktop stdio bridge: a zero-dependency
// JSON-RPC 2.0 server that exposes the board's tools over stdin/stdout.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

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

	if err := mcp.Serve(ctx, os.Stdin, os.Stdout, mcp.NewClient(server, channel)); err != nil {
		fmt.Fprintln(os.Stderr, "mcp-bridge:", err)
		os.Exit(1)
	}
}
