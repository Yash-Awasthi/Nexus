# Nexus — Feature Status (local, no paid APIs)

_Last verified 2026-09-29._ _Stack: Fastify API (`:3000`) + React Router UI (`:5173`) + local Ollama (`:11434`, `qwen2.5:7b` + `nomic-embed-text`) + Neon Postgres + local Redis (`:6379`). Tier gating is OFF — the only gate is login._

**How to test the AI quickly:** register in the UI, then any LLM page works locally. Or curl:

```bash
API=http://localhost:3000
T=$(curl -s -X POST $API/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@x.io","password":"LocalDev12345!"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s -X POST $API/api/v1/gateway/messages -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' \
  -d '{"model":"ollama/qwen2.5:7b","messages":[{"role":"user","content":"hi"}]}'
```

---

## ✅ Working (verified end-to-end, local)

The sidebar lists every page the app has; there is no hidden experiments area. The toy and
duplicate pages (God Mode, Gauntlet, Drift, Simulation, Voice, Image Gen and about sixty more)
were removed from the UI, and their API routes, stores and packages went with them. The
deliberation techniques worth keeping live inside the council page: reasoning modes, the debate
round, blind review, answer styles, domain focus and ruled-out rules. A few rows below (Red Team,
STM, A/B Arena, Agents) describe API that outlived its page.

| Nav item                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                      | loads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Deliberations                  | Real council on both paths, from one archetype registry. `/api/v1/council` runs 5 **archetypes**, each casting an LLM vote on its own model (`packages/council/src/engine.ts`). The Deliberations page posts to `POST /api/chat/stream`, which runs the streamed multi-round debate (`packages/council/src/debate.ts`) with the same personas; its verdict clusters each member's stated final answer and says "no majority position" when they do not converge.                                                                                                                                   |
| Discussion mode                | `POST /api/v1/discussion/stream` (`routes/discussion.ts` + `packages/council/src/discussion.ts`). Participants run independent loops over an append-only ledger instead of taking rounds, so a fast model contributes several times while a slow one contributes once. A supervisor keeps the record and is the only judge of when a result has arrived; wall time, contribution count and token total are all caps in the loop. The `/discussion` page drives it with the same council membership Deliberations uses. The ledger is not persisted past the stream — close the tab and it is gone. |
| Archetypes                     | durable per-user registry (`routes/archetypes.ts` + `lib/archetype-store.ts`); the built-ins are seeded rows. Every `/api/v1/council` path resolves its members from it, so a custom archetype votes, on the model and temperature its owner assigned.                                                                                                                                                                                                                                                                                                                                             |
| Workflows                      | CRUD + DAG run engine (see below); the editor canvas is kept with the workflow on the server; a workflow with a `schedule` (five-field cron, server time) runs on it with no one watching                                                                                                                                                                                                                                                                                                                                                                                                          |
| Prompts                        | Postgres CRUD + versions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Skills                         | store-backed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Knowledge Bases                | KG-store backed list + docs; ingest extracts entities/relationships via `@nexus/nlp-utils` over the default LLM driver (fails soft to zero when no model answers)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Knowledge graph                | entities and relationships drawn in 3D: turn it, zoom, pick an entity for its links, search by name. `GET /api/kg/graph` returns the best-connected entities. `POST /api/kb/:id/graph` reads a base's chunks into the graph in the background (two model calls per chunk, 50 chunks by default, 200 at most, optionally only some entity types): it answers 202 with the job, `GET` reports progress, and a notification arrives when it ends. A restart forgets the job, not the graph; deleting an entity or relationship keeps a tombstone that a sync carries to peers                         |
| Search                         | one query across your knowledge bases, knowledge graph and the web (`POST /api/search`); each source is numbered, the page marks the matching words, and an answer cites the sources it used and lights them                                                                                                                                                                                                                                                                                                                                                                                       |
| Home (landing)                 | scroll-driven 3D scene of seven council members (three.js) that seat, argue, gather on a verdict and fan work out; anime.js drives the reveals, an example deliberation and the tilt cards. Without WebGL the page keeps a CSS backdrop; reduced motion draws the scene still                                                                                                                                                                                                                                                                                                                      |
| Memory                         | remember, recall by meaning, forget, merge duplicates, from the page and `nexus memory`; recall also lists the knowledge-graph entities the question names. Embedder via `NEXUS_EMBED_PROVIDER`: ollama (default, 768-dim), groq, openai, voyage, jina, cohere (key-gated), fixed                                                                                                                                                                                                                                                                                                                  |
| Connectors / Add / Sync Status | per-user connectors (credentials encrypted); sync pulls documents through `@nexus/connectors` into a knowledge base; load / poll / slim modes; cron schedules run in-process                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Red Team (prompt-filter)       | `@nexus/redteam`; the code page (Parseltongue) runs five specialist reviews on the default model, with @-mention context                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| STM                            | transform pipeline; history, active modules and per-project overrides are per user and durable (`routes/stm-bridge.ts` + `lib/stm-store.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Deep Research                  | the shared web search, then a synthesis on the caller's model; works with no search key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A/B Arena                      | `raceModels`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Answer ratings                 | thumbs up or down on a chat answer, kept per account, listed on the RLHF page and summed on Admin → Feedback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agents                         | browser agent tasks; the librarian (memory + knowledge graph recall) backs the memory page; file agents are admin API only                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Projects                       | `/api/v1/projects` CRUD; the Company tab hands a project to a company as one of its goals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Marketplace                    | plugin registry; installing creates the item's archetypes, prompt, workflow or skill for the caller, uninstall removes them                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Sandbox                        | JS (Node vm) + Python (Pyodide/WASM) local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Drive                          | per-user storage with a shell (sandboxed in Docker when available), 512 MB quota; exports as `.tar.gz` with every `.env` left out; any other file can be downloaded or shared through a signed link that expires (30 minutes by default, at most 7 days)                                                                                                                                                                                                                                                                                                                                           |
| Moderation                     | OpenAI moderation or heuristic fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Settings / Profile             | preferences store; chat honours auto-council, debate rounds, verbosity, deliberation mode, dissent, cold validator, PII detection/redaction and content filters; profile saves name, deletes and exports conversations                                                                                                                                                                                                                                                                                                                                                                             |
| Cost Analytics                 | from real `_costLog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| API Tokens                     | `nxk_` + sha256, in-memory (bridge `/tokens`; no Postgres-backed tokens surface exists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Provider Keys                  | AES-256-GCM encrypted, Postgres; any OpenAI-compatible endpoint can be saved under its own name (base URL, default model) and used as `name/model`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| OpenAI API                     | `/v1`: models, chat completions (JSON or SSE, tools both ways), completions, embeddings, files and batches; an OpenAI client works with its base URL pointed here                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Notifications                  | **real per-user store** (shared KV, 30-day TTL) + sidebar bell + dashboard Activity feed; live emitters: research done/failed, org approvals, budgets and failed runs; the weekly digest counts agent runs and decisions waiting                                                                                                                                                                                                                                                                                                                                                                   |
| Standard Answers               | persistent + LLM match                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Admin → Users                  | **real Postgres `users` table**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Admin → Analytics              | accounts, model requests, tokens and spend across the instance (no invented numbers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Admin → Audit Log              | **real hash-chained `audit_log`** (populates on register/provider-key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Admin → Traces                 | model calls per request (provider, tokens, latency, failover attempts), admin only, newest 1000 kept across restarts (a `nexus_kv` row each, or an appended JSONL file)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Feature Flags                  | store-backed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Feedback                       | **real store + reactions signal** + `POST /feedback`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Cost / Costs limits            | real env + spend/remaining                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Company                        | companies of agents with an org chart, goals, a task board, scheduled and event-driven runs, budgets with hard stops, an approvals inbox, routines, memory and templates — see the Company section below                                                                                                                                                                                                                                                                                                                                                                                           |

## 🏢 Company (org layer)

`/org` runs companies of agents. The API is `/api/org/*` (`apps/api/src/routes/org*.ts` over
`apps/api/src/lib/org-*.ts`) and the CLI is `nexus org`. The design and the Paperclip comparison it
came from are in `docs/design/paperclip-comparison.md`.

- **Structure.** Companies, agents with roles, reporting lines and an archetype persona, and goals.
  Tasks carry identifiers like `ACME-12`, priorities, blockers, comments and work modes (do the work,
  plan only, answer only). One run at a time can check a task out. Each edit to an agent's config
  keeps the config it replaced (the last 50), and the agent's sheet can restore one; a restore is
  itself an edit, so it can be undone.
- **Runs.** Assignments, board comments, heartbeats (an interval or cron), routines and approvals wake
  an agent. Wakes for an agent that is already busy fold into its current run. A run checks out the
  next task, builds a prompt from the task's "why" chain, recalled lessons and the team roster, and
  applies the outcome the agent reports: close, review, block, delegate, triage, propose a hire, or
  ask for approval. Runs a restart interrupted fail on boot; runs past their deadline are reaped.
  A CLI runtime's tool calls and messages stream into the run log while it works. A manager with
  a heartbeat and nothing assigned files itself a review task only when its team has something
  waiting (a review older than an hour, a blocked task, a budget past its warning share).
  A run whose task was handed to another agent meanwhile keeps its deliverable as a comment but
  no longer moves the task. Review dedupe, the webhook replay guard and running discussions are
  persisted, so a restart files no repeat review, accepts no replayed signature, and closes an
  interrupted discussion with a comment. Every morning the owner gets one notification listing
  reviews waiting over an hour, blocked work, approvals waiting over a day and budgets past their
  warning share, built with no model call; the org page previews it and can send it now. Each
  item acts in place: approve or reject an approval, unblock or accept a task, or hand it to
  another agent. The notification links straight to the open inbox.
- **Replay and discussion.** A finished run keeps its exact prompt server-side and can be replayed
  on another model, with the two answers diffed; the replay never fails over and is billed to the
  run's agent. A whole task can be replayed too: each of its runs, oldest first, with what every
  call cost and which status it reported side by side. A replay on a paused company or agent is
  refused unless the company's "Replays run while paused" setting is on; budgets apply either way.
  Two to five agents can discuss a task in its thread: rounds on the council debate, each turn a
  comment by that agent, until they agree or three rounds pass. Turns can run in order, each agent
  seeing the turns before it, and an agreed decision is filed as a subtask for the most senior
  agent in the discussion. When that subtask is done or cancelled, the discussion's thread hears
  how it ended, quoting the agent's last word on it. Each agent's sheet scores the models it ran
  on and was replayed on: runs and how many ended done, replays and how often they reported the
  same status, and the mean cost of a call, and names a cheaper model once at least three replays
  agree with the current one.

- **Runtimes.** `nexus` (the owner's provider keys first, with failover), Claude Code, Codex, Gemini
  CLI, OpenCode, any shell command, or an HTTP webhook. A process runtime passes the exec policy once
  per agent and command and never inherits the server's environment. A webhook goes through the
  pinned SSRF guard; private origins need `NEXUS_ORG_HTTP_PRIVATE_ORIGINS`. A `nexus` agent may name
  a cheaper quick model for answer-only tasks and triage.
- **Money.** Budgets per company, agent or goal, by day, month or lifetime. Crossing the warning
  share notifies you; crossing the limit pauses the scope and cancels its queued runs. Each model call
  is checked beforehand at its worst-case price: failover skips any provider whose model could cross
  a limit, and the call is refused only when none fits. Calls are priced by provider-qualified model. A forecast dates when each limit will run out.
- **Governance.** One inbox for hires, budget overrides, plans, agent requests and command
  approvals. The council can review any request first, and can check work an agent calls done
  before it counts (company settings). Governance actions go to the hash-chained audit log.
- **Sharing.** A company can be shared with one of the owner's workspaces (`/workspaces` creates one,
  invites by email, lists and revokes pending invitations, changes roles and removes members; an
  invitation joins only the invited email). Members read everything, with agent configs scrubbed as
  an export would be, comment on tasks, file new tasks and hand a task to another agent; each change
  is logged as theirs and a member's comment never wakes, assigns or teaches an agent. Agents are
  told that member-written text is information, not the board's instruction. Viewers only read.
  Approvals, budgets, hires, deleting, replay, discussions and exports stay with the owner. What a
  member may change, and which fields each change may carry, is one table the server enforces; each
  company in the list says what the caller may do (`can`), and the UI shows only those controls.

- **Learning and knowledge.** Finished work and board comments become lessons, captured with no model
  call and recalled by relevance on later runs; they are mirrored to Nexus memory when it can embed.
  An agent also reads the knowledge bases picked for it and the owner's personal memory.
- **Skills.** Skills attached to an agent or a mission run through the exec gate like any process
  (keyed on the skill's code, so an edit asks again), and their real output goes into the prompt.
  Params that rewrite a skill's code mid-mission run only when the policy allows the result.
- **Across Nexus.** A workflow's Company Task step files its data as a task and can wait for the
  deliverable. A council verdict in chat can be sent to a company, whose top agent splits it into
  work. A project can be handed to a company as one of its goals. The dashboard and the weekly digest
  summarise every company. Autopilot was removed: its architect, coder and reviewer loop is what a
  Software team company does, with budgets, approvals and memory it never had.
- **Portability.** Export a company as JSON with no secrets or machine paths, import it for any
  account, or start from the Content studio, Software team or Research desk template.

Verified live against the desktop-mode API on Groq keys (Gemini and Mistral keys were rate-limited
or refused on 2026-09-27; the TokenRouter account had no credit), and earlier with the real Claude
Code, Codex, Gemini CLI and OpenCode binaries. Each surface has a vitest suite
(`apps/api/tests/lib/org-*.test.ts`) and a Playwright spec at 375px width in `apps/ui/tests/e2e`
(`pnpm test:e2e`; model-calling specs need `E2E_MODELS=1`).

## ⚙️ Needs a key/runtime (code is real, just unconfigured)

- **Sandbox Go/Rust/Ruby/etc** → local Piston (`PISTON_URL`); JS + Python already work with nothing.
- **Language Models leaderboard** → curated static numbers, labeled `measured:false` (intentional, not live-benched).

## 🔒 Exec approvals (Stage F-Tier1)

Anything Nexus executes passes `@nexus/exec-policy` first, which answers allow, ask or deny for a
described action and nothing else — it performs no I/O and runs nothing itself.

`NEXUS_EXEC_MODE` picks the posture: `readonly` (nothing executes), `ask` (read-only commands run,
everything else needs a human — the default, including when the variable is unset or misspelled), or
`trusted` (allowlisted commands run unasked, the rest still ask). `NEXUS_EXEC_ALLOW`,
`NEXUS_EXEC_DENY` and `NEXUS_EXEC_ROOTS` add operator rules and a workspace boundary. A deny is never
overturned by an allow rule, and an action nothing covers asks rather than runs.

`POST /api/local/pty` is gated: a denied command answers 403 with the rule that decided it, and a
command the policy stops for answers 202 with an approval id instead of spawning. A human answers at
`/api/v1/exec/approvals`; replaying the request with that id spawns exactly the command that was
approved. Approvals are per user, single use, bound to the exact command and arguments, and expire
ten minutes after they are asked for — including after they are granted. On a shared server (not the desktop app) a host shell that the policy stops for is refused
outright unless the caller is an admin: a member approving their own shell on the host would be
a privilege escalation, so only the operator grants it, by role or by an allow rule. The same
rule holds at the approve endpoint, so a shell command an org agent asks for is an admin's to allow.

Every executing surface now passes the same gate, with a default per surface rather than one rule for
all four: `pty` asks for anything uncovered because it starts a process on the host;
`sandbox`, `repl` and `tool` run by default, because the isolated runtime (or, for tools, the existing
auth and per-route guards) is the control there and stopping for each cell would train an operator to
approve without reading. Node's `vm` is not a security boundary, and that is why the default is stated
in one table with its reasoning rather than left implicit. An operator raises any surface with
`NEXUS_EXEC_ASK_SURFACES`, and `readonly` mode plus deny rules override every default.

MCP tool calls answer inside the protocol: a refusal is JSON-RPC `-32004` and a pending approval is
`-32003` carrying the id to come back with, because an MCP client reads error objects, not HTTP
status codes.

## 🗝️ Secret store (Stage F-Tier1)

`GET/PUT/DELETE /api/v1/secrets` holds named secrets per user, encrypted at rest with the existing
AES-256-GCM helper, which fails closed: with no `NEXUS_SECRETS_KEY` the store refuses to write rather
than keeping a plaintext copy.

**No route returns a value.** Not a masked one, not a prefix — a `fingerprint` (eight hex of the
value's SHA-256) is the whole read surface, enough to confirm a rotation and useless otherwise.
Server-side consumers call `resolveSecret` in-process, which stamps `lastUsedAt` so an owner can see
that a secret is in use without seeing what it says.

`POST /api/v1/secrets/requests` is the path that keeps a value out of the transcript: an agent records
the name it needs and why, and the owner supplies the value with `PUT`, which closes the request. A
request with no reason is refused, because nobody can judge it.

## 🖥️ Desktop shell (`apps/desktop`, milestone M1)

The Electron shell boots, loads `apps/ui` from `NEXUS_DESKTOP_URL` (default the dev server on
`127.0.0.1:5173`), and exposes one bridge object to the renderer. `pnpm --filter @nexus/desktop
smoke` boots it headless and prints the capability list the renderer can see.

The renderer asks what its host can do, never which host it is (`apps/ui/app/lib/host.ts`). The
shell declares `localAccount`, `providerSignIn`, `glass` and `councilSync`; deliberations, threads and
memory run over HTTP against the local API exactly as they do in a browser, so the shell does not
reimplement them, and a method reached without its capability throws instead of doing nothing quietly.

Sign-in opens the API's OAuth entry point in a window the app owns. The callback never loads: the
main process cancels that navigation and fetches it, so the authorization code is spent there rather
than rendered into a page. The session is sealed with `safeStorage` — the OS keychain — and the
renderer receives the access token in memory only, never in `localStorage`. With no keychain
available the sign-in is refused rather than written unencrypted. Refresh is an HTTP call with no
window. Provider links use the same window, and the API keeps the provider tokens, so the desktop
holds no provider credential.

**M2 (local API) is in.** With neither `NEXUS_DESKTOP_URL` nor `NEXUS_API_URL` set, the shell boots
the real Fastify API as a child process on a free loopback port, against an embedded Postgres
(`@electric-sql/pglite`) under the app's data directory, serving the built `apps/ui` from the same
origin — so every `/api/*` call the UI makes is same-origin, and the whole app runs with no server
and no network. The renderer asks `getRunMode` and is told `local-only` or `cloud`; it is never left
to assume.

**M3 (sync) is in.** `syncNow` runs pull → merge → push against `NEXUS_SYNC_URL` over the existing
`/api/v1/session-sync` surface. A key changed on both machines is settled by logical time, ties by
device id, and every losing value is kept in a ledger entry (`getSyncLedger`) naming which side won.
A failed run records the error and leaves the cursor alone, so the next run retries exactly what did
not land.

Migrations run against the embedded database, so local accounts work (the first account becomes
the owner), and memory, knowledge bases and shared state persist in it without Redis; PGlite loads pgvector for memory search.
The served UI's inline boot scripts are allowed by hash in the script policy.

**Checked end to end (2026-09-28).** `pnpm --filter @nexus/desktop test:e2e` drives the built app
through Playwright's Electron support from a clean data directory: a first launch asks for a local
account (email and password, session sealed in the keychain), a Groq key is saved, a company is
created and does real work, two agents discuss, the inbox unblocks a task, the sandbox runs
JavaScript and a Python kernel keeps its variables, closing the window leaves the app in the tray,
and after a restart the session and the company are still there. The app mints its own API key,
secrets key, session-signing key and audit key per install. Ollama and LM Studio are offered as
keyless local providers. With no Redis, coding-agent runs and interrupted browser tasks run in the
API process on the owner's own keys. Electron 44 (Node 24).

Not there yet: an installer, code signing and auto-update (M4) — the API still runs from the
workspace with the `tsx` loader, so a package needs it bundled first. The OAuth round trip has not
been exercised against a live provider — it needs registered client credentials, which are an
operator action.

## 🔧 Has code but needs plumbing (partial — real handler, missing engine/wiring)

- Nothing outstanding.

## ❌ Not built yet (nav item with no real backend)

- **Billing / subscription** — intentional: Nexus is free + BYOK, checkout is a no-op.

## Architecture — invariants (durable rules; the passes that established them are in git history)

Each concern has ONE owner; everything else imports it. Breaking any rule below
reintroduces a bug that was found and fixed live — don't.

**Outside text in prompts:** web pages, knowledge-base passages, webhook payloads and tool
output pass through `screenUntrusted` (`@nexus/shared`) and sit under `UNTRUSTED_NOTE` before
they reach a model. A new place that puts outside text into a prompt does the same.

**Per-user durable stores (KV-backed, survive restarts):** notifications
(`lib/notifications-store.ts`), threads (`lib/threads-store.ts`), research jobs
(`lib/research-jobs.ts`), session/mission graphs (`lib/session-graph.ts`,
`lib/mission-graph.ts`). All: per-key mutation locks via `lib/with-key-lock.ts`,
write-through on mutation, newest-first by list position (timestamps can tie —
never sort by `createdAt` alone), completion persisted BEFORE the SSE event or
notification that links to it. `requireAuthWithTier` resolves the caller — never
reintroduce anon-defaulting or process-level state for these surfaces in
api-bridge (re-adding a moved route there throws `FST_ERR_DUPLICATED_ROUTE`).

**api-bridge is a legacy bridge:** it holds mutable process state (`_costLog` is
bound to the durable `lib/cost-log.ts` store). New store-backed features get
their own `routes/*.ts` + `lib/*.ts` module (the research.ts precedent: narrow
typed deps, registered from inside `apiBridgeRoutes`).

**Usage/cost log** (`lib/cost-log.ts`): in-memory record + write-behind flush to
day-sharded KV keys (150-day TTL). `load()` mutates in place — reassignment
strands pre-bound readers (compiler-enforced: `entries` is `readonly`). Flush
health rides `/health/ready` (`costLog` block); a graceful close flushes the
pending tail. Best-effort by design: an unclean kill loses at most the last few
seconds, never the history.

**Rate limiting** (`lib/rate-limiter.ts`): atomic `KVStore.incr` only — the
EXPIRE/TTL is stamped exactly once at key creation; in-window traffic must never
refresh the expiry or the bucket never drains. Fail-open on KV outage.

**LLM cache + failover** (`lib/llm-cache-driver.ts`, `lib/llm-failover.ts`):
`getDefaultDriver()` returns FailoverDriver over CachingDriver-per-provider.
Cache is deterministic-only (temperature > 0, tools, tool-role messages bypass;
streams store only clean full completions); keys include provider + model +
caller (AsyncLocalStorage); hits return zeroed usage so cost stats stay honest;
fail-open on KV errors; `LLM_CACHE_DISABLED=1` bypasses. Failover order:
`NEXUS_LLM_PROVIDER` first, then the historical default order. Provider health +
discovery ride `/health/ready` (`llmProviders` block).

**Session/mission graphs** (`lib/session-graph.ts`): zero-write-cost capture —
no LLM call ever made to store memory; `edge.from === "last"` sentinel resolves
to the previous node; the first node on an empty graph gets no self-edge.
`lib/mission-memory.ts` is the READ side: `distillMissionMemory` turns the
captured graph into one bounded prompt block; `continueFrom` feeds it back.

**Skills** (`routes/skills.ts`, `lib/skill-merge.ts`, `lib/skill-compress.ts`,
`lib/skill-runner.ts`, `lib/skill-embed.ts`): merge/compress/run are separate
operations; the store persists full skill code (dropping `code` was a real
data-loss bug); comment markers must match the composite's language
(`commentPrefix()` — `#` vs `//`); skill relevance is embeddings-based with a
keyword fallback; `executeSkillsOnce()` pre-executes attached skills
deterministically so work happens even if the model never emits a tool call.

**Frontend:** one client source per concern — `NotificationsContext` owns the
tray (never re-add it to `/api/dashboard`), `lib/deliberate.ts` owns thread
state (pages must not re-implement fetch/fallback/mapping), the bell tray and
Activity feed stay behavior-identical (mark-read + navigate). Charts stay
pre-bundled in `apps/ui/vite.config.ts` (`optimizeDeps.include`) — removing
that reintroduces the duplicate-React crash.

**Research engine bounds:** synthesis + related-questions go through
`withTimeout(RESEARCH_LLM_TIMEOUT_MS)`; the Tavily fetch is bounded by
`AbortSignal.timeout(15 s)`; a `running` job older than 5 min is recovered to
`error` on read (the engine can never legitimately run that long).

## ⚠ Behaviour change for existing SSO deployments

Enterprise SSO (`/auth/oidc/*`, `/auth/saml/*`) used to create a Nexus account for any address
the identity provider asserted. It no longer does: it links to an account that **already exists**,
and refuses with 403 `no_account` otherwise. OIDC additionally requires `email_verified` to be
strictly true — a provider that omits the claim is no longer treated as having verified the
address.

A deployment that relied on accounts appearing on first sign-in must set both:

```bash
NEXUS_SSO_AUTO_PROVISION=1
NEXUS_SSO_ALLOWED_DOMAINS=example.com,subsidiary.example
```

Why the default flipped: an assertion proves the IdP believes a claim, nothing more. At a provider
where anyone can sign up, or one where a user edits their own profile email, unconditional creation
lets a stranger mint accounts — and where the asserted address matches an existing user, take that
account over. Consumer sign-in (Google/GitHub) is unaffected; creating an account there is the point.

SAML's user lookup also now skips soft-deleted rows, which every other auth path already did. An
erased account is no longer revived by signing in.

## Known caveats

- Models with no price row (TokenRouter's models, which publish no prices) are billed at the default rate
  of $1 in and $3 out per million tokens, which can overstate their cost, and so the model
  scorecard will not suggest them. Prices live in one table, the model catalog in
  `lib/model-discovery.ts`, keyed by provider and model.
- On a shared server, rows written before owner scoping (old groups, projects and their tasks, prompts, build tasks,
  knowledge bases, workflows) belong to no account; on the desktop app they stay the user's. An
  admin sees how many there are with `GET /api/v1/admin/ownerless` and hands them all to one
  account, once, with `POST /api/v1/admin/ownerless/assign` and `{ "userId": "..." }`.
- A shell for a mission or a worker coding run that needs approval must be named by the client
  (`missionId`, `sessionId`), because the approval is bound to that id; the UI and CLI do this.
- A discussion counts as agreed when every agent's one-line `FINAL:` decision shares most of its
  words with the others' (the council's word-overlap clustering). Synonyms are missed ("use
  Postgres" and "go with PostgreSQL" read as a disagreement), so a real agreement can run to the
  round limit. This is deliberate: a model-judged comparison would spend budget on every round and
  could be wrong in the other direction, and the whole thread stays readable either way.
- Claude Code costs about $0.12 per run even for a one-line answer, because of its system prompt; give
  such agents a budget.

- Billing/subscription is intentionally a no-op: Nexus is free + BYOK.
