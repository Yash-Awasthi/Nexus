// SPDX-License-Identifier: Apache-2.0
/**
 * nexus local bridge — let cloud agents reach THIS machine.
 *
 * The mechanism behind "ChatGPT codes, Gemini investigates, Claude architects,
 * DeepSeek (free worker) connects": a small, token-gated HTTP server that
 * exposes the same confined tool set the worker's agent loop uses (file
 * read/write/edit/list, shell, MCP passthrough) over JSON RPC. A cloud-side
 * agent fetches /connector-instruction, learns the endpoint + auth header +
 * tool schemas, and calls back into your laptop from anywhere.
 *
 * Self-hosting for the deployed case: run behind a public tunnel
 *   cloudflared tunnel --url http://localhost:8787      (or ngrok)
 * and give the agent the https URL. The bearer token is the only gate — use a
 * long random one (openssl rand -hex 32).
 *
 * Zero new deps: node:http + the worker's existing @nexus/agent-runtime tool
 * set (createCodingToolSet) which confines every file/shell op to the bridge
 * root and rejects path/symlink escapes.
 *
 * Env:
 *   NEXUS_BRIDGE_TOKEN      required (>= 12 chars)
 *   NEXUS_BRIDGE_PORT       default 8787
 *   NEXUS_BRIDGE_ROOT       confined workspace root (default <cwd>/data/bridge)
 *   NEXUS_BRIDGE_ALLOW_SHELL  default "1" (set "0" to disable run_command)
 *   NEXUS_BRIDGE_MCP_SERVERS  optional JSON: [{name, serverUrl, apiKey?, headers?}]
 *   NEXUS_BRIDGE_LABEL      optional display label in the connector payload
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { mkdirSync } from "node:fs";

import { createCodingToolSet } from "./handlers/agent-tools.js";
import { mcpToolsFromServers, type McpServerConfig } from "./handlers/agent-mcp.js";

// ── Config ────────────────────────────────────────────────────────────────────

const TOKEN = process.env.NEXUS_BRIDGE_TOKEN ?? "";
const PORT = parseInt(process.env.NEXUS_BRIDGE_PORT ?? "8787", 10);
const ROOT = path.resolve(
  process.env.NEXUS_BRIDGE_ROOT ?? path.join(process.cwd(), "data", "bridge"),
);
const ALLOW_SHELL = (process.env.NEXUS_BRIDGE_ALLOW_SHELL ?? "1") !== "0";
const LABEL = process.env.NEXUS_BRIDGE_LABEL ?? "user's local machine";

const BODY_LIMIT = 10 * 1024 * 1024; // 10 MiB

export interface BridgeServer {
  url: string;
  close: () => Promise<void>;
}

/** Constant-time compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      data += c.toString("utf8");
      if (data.length > BODY_LIMIT) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => (tooBig ? reject(new Error("payload too large")) : resolve(data)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Read the bearer token from an incoming request, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

/** True when the request carries a valid bridge token. */
function authed(req: IncomingMessage): boolean {
  const t = bearerToken(req);
  return !!t && safeEqual(t, TOKEN);
}

/** Render the agent-facing connector instruction (protocol + examples). */
function connectorInstruction(host: string, token: string): string {
  const base = `http://${host}`;
  const tools = [
    {
      tool: "list_projects",
      args: "{}",
      note: "Top-level project dirs under the bridge root.",
    },
    {
      tool: "list_files",
      args: '{"path": "."}',
      note: "List files in a project dir.",
    },
    {
      tool: "read_file",
      args: '{"path": "<project>/<file>"}',
      note: "Read a local file (64 KiB cap).",
    },
    {
      tool: "write_file",
      args: '{"path": "<project>/notes.md", "content": "..."}',
      note: "Write a file back to the local machine.",
    },
    {
      tool: "edit_file",
      args: '{"path": "...", "old_str": "...", "new_str": "..."}',
      note: "First-occurrence in-place edit.",
    },
    {
      tool: "run_command",
      args: '{"command": "node -v"}',
      note: "Shell in the bridge root (scrubbed env).",
    },
  ];
  return `# Nexus Local Bridge — connector protocol

You have access to the ${LABEL} through the Nexus Local Bridge. Use it when the
task needs a local file, a shell command on the user's machine, or a project
workspace. Everything is scoped to the bridge root; you cannot reach outside it.

Endpoint : ${base}
Auth     : Authorization: Bearer <token>  (${token.length} chars, provided by the operator)

## Tools (POST ${base}/rpc with JSON {"tool": "...", "args": {...}})

${tools.map((t) => `- \`${t.tool}\` — ${t.note}\n  args: ${t.args}`).join("\n")}

Additional tools (from configured MCP servers) are listed by GET
${base}/capabilities — inspect it before calling an unfamiliar tool.

## Example — fetch + write back

1. List projects:
   curl -s -H "Authorization: Bearer $TOKEN" ${base}/rpc \\
     -d '{"tool":"list_projects","args":{}}'
2. Read a file:
   curl -s -H "Authorization: Bearer $TOKEN" ${base}/rpc \\
     -d '{"tool":"read_file","args":{"path":"my-app/README.md"}}'
3. Write a result back:
   curl -s -H "Authorization: Bearer $TOKEN" ${base}/rpc \\
     -d '{"tool":"write_file","args":{"path":"my-app/agent-notes.md","content":"Investigated: ..."}}'

## Rules
- Prefer reading before writing. Never overwrite a file you did not first read.
- Paths are relative to the bridge root and must stay inside it.
- run_command is confined to the bridge root; use it for tests/builds the user
  asked for, not for anything destructive.
- When you finish, summarize what you changed on the local machine.
`;
}

export async function startBridgeServer(opts: {
  token?: string;
  port?: number;
  root?: string;
  allowShell?: boolean;
  mcpServers?: McpServerConfig[];
  label?: string;
}): Promise<BridgeServer> {
  const token = opts.token ?? TOKEN;
  const port = opts.port ?? PORT;
  const root = path.resolve(opts.root ?? ROOT);
  const allowShell = opts.allowShell ?? ALLOW_SHELL;
  const label = opts.label ?? LABEL;

  if (!token || token.length < 12) {
    throw new Error(
      "nexus-bridge: NEXUS_BRIDGE_TOKEN is required (>= 12 chars). " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  mkdirSync(root, { recursive: true });

  // Confined tool set — every file/shell op stays inside `root`.
  const toolSet = createCodingToolSet({ rootDir: root, enableShell: allowShell });
  toolSet.add({
    name: "list_projects",
    description:
      "List project workspaces on this machine: top-level directories under the bridge root.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).join("\n") || "(none)";
    },
  });
  // MCP passthrough: configured remote MCP servers arrive as ordinary tools.
  const mcpServers = opts.mcpServers ?? [];
  if (mcpServers.length) {
    for (const tool of await mcpToolsFromServers(mcpServers)) toolSet.add(tool);
  }

  const toolList = toolSet.list().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? { type: "object", properties: {} },
  }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") {
      return json(res, 200, { ok: true, service: "nexus-local-bridge", toolCount: toolList.length });
    }
    if (!authed(req)) {
      return json(res, 401, { error: "unauthorized", message: "Bearer token required" });
    }

    try {
      if (route === "GET /capabilities") {
        return json(res, 200, {
          protocol: "nexus-local-bridge/1",
          label,
          root,
          allowShell,
          auth: "bearer",
          tools: toolList,
        });
      }
      if (route === "GET /connector-instruction") {
        return text(res, 200, connectorInstruction(req.headers.host ?? "localhost:8787", token));
      }
      if (route === "POST /rpc") {
        const raw = await readBody(req);
        const body = (raw ? JSON.parse(raw) : {}) as {
          tool?: string;
          args?: Record<string, unknown>;
        };
        const toolName = body.tool ?? "";
        if (!toolSet.has(toolName)) {
          return json(res, 404, {
            error: "unknown_tool",
            message: `Tool '${toolName}' not found. GET /capabilities for the list.`,
          });
        }
        const result = await toolSet.invoke(toolName, body.args ?? {});
        if (result.error) return json(res, 200, { ok: false, tool: toolName, error: result.error });
        return json(res, 200, { ok: true, tool: toolName, output: result.output });
      }
      return json(res, 404, { error: "not_found", route });
    } catch (err) {
      return json(res, 500, {
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  server.removeAllListeners("error");

  const url = `http://127.0.0.1:${port}`;
  console.log(
    JSON.stringify({
      level: "info",
      event: "bridge.ready",
      url,
      root,
      tools: toolList.length,
      shell: allowShell,
      mcpServers: mcpServers.map((s) => s.name),
      // Public reachability: self-host behind a tunnel, e.g.
      //   cloudflared tunnel --url http://127.0.0.1:8787
      hint: "expose with: cloudflared tunnel --url " + url,
    }),
  );
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// ── Direct run: pnpm --filter @nexus/worker exec tsx src/bridge.ts ───────────
async function main(): Promise<void> {
  let mcpServers: McpServerConfig[] = [];
  const rawMcp = process.env.NEXUS_BRIDGE_MCP_SERVERS;
  if (rawMcp) {
    try {
      mcpServers = JSON.parse(rawMcp) as McpServerConfig[];
    } catch (e) {
      console.error("nexus-bridge: NEXUS_BRIDGE_MCP_SERVERS is not valid JSON:", e);
    }
  }
  try {
    await startBridgeServer({ mcpServers });
  } catch (e) {
    console.error("nexus-bridge failed to start:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /(^|[\\/])bridge\.ts$/.test(process.argv[1]);
if (isMain) void main();
