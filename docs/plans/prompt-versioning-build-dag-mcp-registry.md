<!-- SPDX-License-Identifier: Apache-2.0 -->

# Plan: Prompt Versioning UI · Build Task DAG · MCP Server Registry

Status: **planned** (committed for review, not yet implemented)
Branch: `claudecode`
Date: 2026-06-22

Three roadmap features from `FUTURE_CONTRIBUTION.md`. They are independent and can
ship as three separate commits. Ordered easiest → hardest. Each is gated on
`pnpm typecheck && pnpm lint && pnpm --filter @nexus/api test` staying green.

---

## Shared finding (affects features 1 & 2)

`build_tasks`, `prompts`, and `prompt_versions` are queried via a **raw `pg.Pool`**
against `DATABASE_URL` (`apps/api/src/routes/api-bridge.ts:242` `_getPool()`), **not**
the drizzle `@nexus/db` connection. Crucially, **none of these three tables have a
migration** — they exist only in the production Neon database. Local dev (docker
postgres + `pnpm db:migrate`) has no such tables, so these pages currently return
empty / error locally.

**Decision:** add formal SQL migrations for all three tables so local dev and any
fresh deploy work. Tables are addressed by raw SQL, so a drizzle schema object is
*not* required, but we add migrations matching the columns the route code already
expects (inferred from the `INSERT`/`SELECT`/`_btRow`/`_promptRow` code).

Current highest migration: `0008_provider_credentials_metadata`. New numbers below.

---

## Feature 1 — Prompt Versioning UI

**Backend: already complete.** Route prefix `/api` (no auth), in `api-bridge.ts`:
- `GET /api/prompts` → `{ prompts: Prompt[] }` (each includes `versions[]`, newest-first)
- `POST /api/prompts` → create prompt (`{ name, description?, content? }`)
- `GET /api/prompts/:id` → single `Prompt` with full `versions[]`
- `POST /api/prompts/:id/versions` → `{ content, model?, temperature? }`, auto-increments `version_num`
- `DELETE /api/prompts/:id`

Shapes (from `_promptRow`, api-bridge.ts:8101):
`Prompt { id, name, description, createdAt, versions[] }`,
`PromptVersion { id, versionNum, content, model, temperature, createdAt }`.

**UI gap:** `apps/ui/app/routes/prompts.tsx` already fetches `versions` (raw
`fetch("/api/prompts/:id")`) and shows a `v{n}` badge, but has **no way to browse,
view, or restore** past versions.

### Tasks
1. **Migration `0009_prompts_and_build_tasks.sql`** (+ `_journal.json` idx 9):
   `CREATE TABLE IF NOT EXISTS prompts(...)`, `prompt_versions(...)` (FK →
   `prompts(id) ON DELETE CASCADE`, `version_num int`, `content text`, `model text`,
   `temperature numeric`, timestamps) **and** `build_tasks(...)` (see Feature 2 — one
   migration covers both raw-pool tables). Columns exactly match the SQL in
   api-bridge.ts (`build_tasks`: `id serial pk, user_id, parent_id, title, description,
   status, claimed_by, claimed_at, output, submitted_at, is_locked, meta jsonb,
   created_at, updated_at`).
2. **`prompts.tsx` — Version History drawer.** Add a "History" button (lucide
   `History`) opening a `Sheet` (`~/components/ui/sheet`) on the right:
   - Scrollable list of `selectedPrompt.versions` — `Badge` for `v{versionNum}`,
     model + temperature, relative `createdAt`.
   - **View**: opens read-only content (reuse a `Dialog` or load into editor as
     read-only preview).
   - **Restore**: `POST /api/prompts/:id/versions` with the old version's
     `{ content, model, temperature }` → creates a *new* version (non-destructive),
     then refetch detail. (Matches existing "save = new version" semantics.)
3. (Defer) Monaco diff view between two versions — nice-to-have, not in v1.

**Files:** `apps/ui/app/routes/prompts.tsx`,
`packages/db/migrations/0009_prompts_and_build_tasks.sql`,
`packages/db/migrations/meta/_journal.json`.

---

## Feature 2 — Build Task DAG

**Backend: already complete.** `GET /api/build/tasks` returns all tasks (200, flat)
including `parentId` (`_btRow`, api-bridge.ts:7974). `/api` prefix, no auth.

**UI gap:** `apps/ui/app/routes/build.tsx` renders a Kanban that **filters out
subtasks** (`tasksByStatus` keeps only `parentId === null`, build.tsx:546). Parent→
child structure is invisible except a "sub" badge inside the detail panel.

**Library:** `@xyflow/react@^12` is **already installed** and already used in
`apps/ui/app/routes/workflows.tsx` (ReactFlow, Background, Controls, MiniMap). No new
dependency.

### Tasks
1. **View toggle** on build.tsx header: "Board" (existing Kanban) ↔ "Graph".
2. **Graph view** with `@xyflow/react`:
   - One node per task; **edge parent→child** via `parentId`.
   - Node color keyed by `status` (reuse the Kanban status→color map).
   - Simple layered layout: compute depth by walking the `parentId` chain (roots at
     depth 0); x = sibling index, y = depth. No `dagre` needed for the expected sizes.
   - Click a node → open the **existing** `TaskDetailPanel` (reuse, no new panel).
   - `Background` + `Controls` + `MiniMap`, mirroring workflows.tsx.
3. Handle orphans (a `parentId` whose parent isn't in the page's 200-row window) by
   treating them as roots; `log`/note this rather than dropping silently.

**Files:** `apps/ui/app/routes/build.tsx` (+ possibly a small
`apps/ui/app/components/build-graph.tsx` to keep the route readable).

---

## Feature 3 — MCP Server Registry UI (most work — new backend + DB)

**Current state:** MCP servers are **in-memory + hardcoded**. `MCPServerRegistry`
(`packages/runtime/src/mcp-registry.ts`) holds servers in a `Map`; the only registered
one is the hardcoded "conductor" bridge (`conductor-mcp-bridge.ts:343`). There is **no
DB table and no CRUD API** — `apps/api/src/routes/mcp.ts` (prefix `/api/v1`, paths
`/mcp`, `/mcp/info`, `/mcp/events`, `preHandler: requireAuth`) only does JSON-RPC
invocation against the hardcoded scraping server. **No MCP UI exists.**

**Client available:** `@nexus/mcp-client` exports `McpClient` + `McpHttpTransport`
(`initialize()`, `listTools()`, `callTool()`), reusable for the "test connection" path.

### Tasks
1. **DB schema** `packages/db/src/schema/mcp-servers.ts` (drizzle, mirror
   `user-provider-credentials.ts` style). Table `mcp_servers`: `id uuid pk`,
   `userId uuid notNull`, `name text notNull`, `description text`,
   `transportType text notNull` (`'http'|'stdio'|'websocket'`), `endpoint text notNull`,
   `encryptedApiKey text` (nullable — encrypted via `secret-crypto.ts`, **never
   returned raw**), `keyPrefix text`, `config jsonb`, `tools jsonb $type<string[]>`,
   `status text default 'inactive'`, `enabled boolean default true`,
   `createdAt/updatedAt`, `lastHealthCheckAt`, `deletedAt` (soft-delete). Indexes:
   `uniqueIndex(userId, name) WHERE deleted_at IS NULL`, `index(userId)`. Re-export
   from `packages/db/src/schema/index.ts`.
2. **Migration `0010_mcp_servers.sql`** (+ `_journal.json` idx 10), matching the schema.
3. **CRUD routes** in `apps/api/src/routes/mcp.ts` (or a new `mcp-servers.ts`
   registered under `/api/v1`), all `preHandler: requireAuthWithTier`, per-user
   (`request.nexusUserId`):
   - `GET /mcp/servers` — list active (no raw key; `keyPrefix` only).
   - `POST /mcp/servers` — validate transport/endpoint; encrypt key fail-closed
     (reuse `encryptSecret` + `SecretCryptoUnavailableError` → 503, exactly like the
     provider-keys route); store.
   - `PUT /mcp/servers/:id` — ownership-checked update (key write-only: empty = keep,
     mirroring the provider-keys metadata-only-edit pattern just shipped).
   - `DELETE /mcp/servers/:id` — soft-delete, ownership-checked.
   - `POST /mcp/servers/:id/test` — decrypt key server-side, build `McpClient` with
     `McpHttpTransport`, `initialize()` + `listTools()`; persist `tools` + `status` +
     `lastHealthCheckAt`; return `{ ok, serverInfo, tools }`. **Ping the user before
     wiring this to a live external endpoint** (per standing API-key discipline) — the
     test path makes a real outbound call.
4. (Defer) Refactor `MCPServerRegistry` to hydrate user servers from the DB at request
   time so invocation can target a chosen server. v1 ships CRUD + test only; invocation
   stays on the existing hardcoded path.
5. **UI route** `apps/ui/app/routes/mcp-servers.tsx` (modeled on `api-tokens.tsx` /
   `provider-keys.tsx`, all via `authFetch`): card list (name, endpoint, transport
   badge, status, tool count), add/edit `Dialog` (name, `transportType` `Select`,
   endpoint, apiKey password, optional `config` JSON `Textarea`), delete confirm, and a
   **Test** button surfacing `serverInfo`/tools or the error. Register in
   `apps/ui/app/routes.ts` + add a sidebar link in `apps/ui/app/root.tsx`.

**Files (new):** `packages/db/src/schema/mcp-servers.ts`,
`packages/db/migrations/0010_mcp_servers.sql`, `apps/ui/app/routes/mcp-servers.tsx`.
**Files (edit):** `packages/db/src/schema/index.ts`, `apps/api/src/routes/mcp.ts`
(or new route module + `server.ts` registration), `apps/ui/app/routes.ts`,
`apps/ui/app/root.tsx`. **Reuse:** `apps/api/src/lib/secret-crypto.ts`,
`apps/api/src/lib/crypto-utils.ts` (`sha256hex`), `@nexus/mcp-client`.

---

## Sequencing & verification

1. Feature 1 (prompts) — smallest; migration + one UI file. Commit.
2. Feature 2 (build DAG) — one UI file, no backend, no new dep. Commit.
3. Feature 3 (MCP) — schema + migration + routes + UI. Commit.

Per feature: `pnpm --filter @nexus/api typecheck`, `pnpm --filter @nexus/ui
typecheck`, `eslint` on changed files, `pnpm --filter @nexus/api test`. Migrations
verified with `docker compose up -d postgres redis && pnpm db:migrate` (note in the
commit if Docker isn't available in this environment — it currently isn't, so
migrations are authored but applied later).

## Risks / notes
- **Raw-pool tables vs drizzle:** migrations 0009/0010 are hand-written SQL (repo
  convention); the build/prompts code keeps using the raw `pg.Pool`. Don't try to route
  those through drizzle — out of scope.
- **MCP test endpoint makes live outbound calls** — gate behind explicit user go, keep
  the key server-side only.
- **MCP key handling reuses the fail-closed BYOK crypto** — never persist plaintext,
  never return the decrypted key over HTTP (same rules as `user_provider_credentials`).
