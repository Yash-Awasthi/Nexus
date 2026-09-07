# Nexus Local Bridge

A token-gated HTTP bridge that lets **cloud agents reach your local machine** —
the mechanism behind "ChatGPT codes, Gemini investigates, Claude architects, and
a cheap worker model connects them to local." A cloud-side agent (ChatGPT,
Gemini, Claude, any agent that can call a URL) fetches the connector
instruction, learns the endpoint + auth header + tool schemas, and calls back
into your laptop to read files, run commands, and write results.

- Server: `apps/worker/src/bridge.ts` (~150 LOC, zero new deps — `node:http` +
  the same confinement-safe tool set the worker's agent loop uses).
- Every file/shell operation is **confined to the bridge root** (`path escapes
  workspace` + symlink guards from `agent-tools.ts`). It cannot touch anything
  outside the configured root.
- Auth: a **bearer token** (`NEXUS_BRIDGE_TOKEN`, ≥ 12 chars) on every request
  except `/health`. Constant-time compare.

## Quickstart (local)

```bash
cd apps/worker
NEXUS_BRIDGE_TOKEN=$(openssl rand -hex 32) \
NEXUS_BRIDGE_ROOT="$(pwd)/data/bridge" \
pnpm exec tsx src/bridge.ts
```

```bash
curl -s http://127.0.0.1:8787/health                                   # {ok:true,...}
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/capabilities
# cloud agent payload: protocol + tools + examples + "paste into ChatGPT/Gemini"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/connector-instruction
```

## Protocol

| Method | Path                     | Auth | Purpose |
|--------|--------------------------|------|---------|
| GET    | `/health`                | no   | liveness |
| GET    | `/capabilities`          | yes  | `{protocol, label, root, tools:[{name,description,parameters}]}` |
| GET    | `/connector-instruction` | yes  | markdown agent payload (endpoint + auth + tool examples) |
| POST   | `/rpc`                   | yes  | `{"tool":"...","args":{...}}` → `{ok, output}` / `{ok:false, error}` |

Built-in tools (from `createCodingToolSet`): `read_file`, `write_file`,
`edit_file`, `list_files`, `run_command` — plus `list_projects` (top-level
directories under the root). Configured MCP servers arrive as additional tools.

### Example

```bash
B=http://127.0.0.1:8787
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"tool":"write_file","args":{"path":"demo-app/notes.md","content":"from cloud"}}' $B/rpc
```

## Giving the connector payload to a cloud agent

1. `GET /connector-instruction` (authed) → paste into ChatGPT / Gemini / Claude:
   it states the endpoint, auth header, tools, rules, and curl examples.
2. The agent calls `POST /rpc` to list projects, read files, run tests, write
   findings back.
3. `list_projects` + `list_files` let it orient itself before acting.

## Self-hosting for the deployed case

The bridge binds `127.0.0.1` by design. Expose it through a public tunnel so
cloud agents can reach it from anywhere:

```bash
# Cloudflare (recommended; also ngrok, tailscale funnel, ...)
cloudflared tunnel --url http://127.0.0.1:8787
# → https://random-name.trycloudflare.com  — give THIS to the agent.
```

Security notes:

- The bearer token is the **only** gate — generate a long random one
  (`openssl rand -hex 32`) and never embed it in the connector payload you paste
  into a third-party chat (the payload already leaves the token out — substitute
  it at call time via a secret store or environment).
- Prefer `NEXUS_BRIDGE_ALLOW_SHELL=0` unless the agent needs to run builds/tests.
- `run_command` runs with a scrubbed environment (`buildSafeEnv` — credentials
  filtered) and confines `cwd` to the bridge root.
- Bridge a real (non-demo) root only after you trust both the agent and the tunnel
  operator; the escape guards are defense-in-depth, not a sandbox against a
  hostile operator of the machine itself.

## Env

| Var | Default | Purpose |
|---|---|---|
| `NEXUS_BRIDGE_TOKEN` | — | **required**, bearer token (≥ 12 chars) |
| `NEXUS_BRIDGE_PORT` | 8787 | listen port |
| `NEXUS_BRIDGE_ROOT` | `<cwd>/data/bridge` | confined workspace root |
| `NEXUS_BRIDGE_ALLOW_SHELL` | `1` | `0` disables `run_command` |
| `NEXUS_BRIDGE_MCP_SERVERS` | — | JSON `[{name, serverUrl, apiKey?, headers?}]` |
| `NEXUS_BRIDGE_LABEL` | "user's local machine" | shown in the connector payload |
