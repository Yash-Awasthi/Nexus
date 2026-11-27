#!/usr/bin/env node
// Launches the vendored board's MCP server over stdio.
//
// The bridge (not `vb mcp`) is preferred: it turns every write into a two-step approval and
// refuses writes entirely when OPEN_BOARD_MCP_READ_ONLY=1. Both speak JSON-RPC on stdin/stdout,
// so an MCP client only needs a stable entry point — this file — rather than a path with a
// machine's username in it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const board = join(repo, "services", "board");
const exe = process.platform === "win32" ? ".exe" : "";

const candidates = [
  join(board, "bin", `mcp-bridge${exe}`),
  join(board, `mcp-bridge${exe}`),
  join(board, "bin", `vb${exe}`),
  join(board, `vb${exe}`),
];

const binary = candidates.find((path) => existsSync(path));
if (!binary) {
  console.error(
    `open-board MCP: no board binary found. Run \`pnpm board:build\` first.\n` +
      `Looked for:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
  );
  process.exit(1);
}

const args = binary.includes(`vb${exe}`) && !binary.includes("mcp-bridge") ? ["mcp"] : [];
const child = spawn(binary, args, { cwd: repo, env: process.env, stdio: "inherit" });

child.on("error", (error) => {
  console.error(`open-board MCP: could not start ${binary}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
