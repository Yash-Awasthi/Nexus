<!-- SPDX-License-Identifier: Apache-2.0 -->

# Paperclip vs Nexus — feature comparison

_Studied 2026-09-27 against `paperclipai/paperclip` at `01d9a12` (MIT). Sources read: README, ROADMAP,
DESIGN, AGENTS.md, adapter-plugin.md, `doc/SPEC-implementation.md`, `doc/PRODUCT.md`, `doc/GOAL.md`,
`packages/db/src/schema/*`, `server/src/services/{budgets,approvals,heartbeat,routines,goals,dashboard}.ts`,
`server/src/adapters/{http,process}`, `packages/adapters/{claude,codex,cursor,gemini}-local`,
`packages/adapter-utils/src/types.ts`, `skills/paperclip/SKILL.md`, `cli/src/commands`._

## 1. What Paperclip is

Paperclip calls itself a control plane for "AI-agent companies". It does not run models itself.
It keeps records of who does what, starts external agent runtimes on a schedule, and enforces
money and approval rules around them. There are two layers:

- **Control plane** (Express + Drizzle/Postgres, embedded PGlite in dev): companies, agents, goals,
  projects, issues, comments, approvals, budgets, cost events, activity log, routines.
- **Execution adapters**: each agent has an `adapterType` and an `adapterConfig`. An adapter's job is
  to turn one heartbeat into one invocation of something external: the Claude Code CLI, Codex,
  Cursor, Gemini, a shell command or an HTTP webhook.

The product loop runs like this. The board (the human) defines a company goal and hires a CEO
agent. Agents wake on heartbeats, check out tasks, do the work in their own runtime and report
back through the REST API using a run-scoped JWT. Each run's cost counts against budgets. Governed
actions wait for the board's approval.

## 2. How the core mechanisms work

### Data model (per company; every row carries `company_id`)

| Entity                                           | Key fields                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companies`                                      | name, status `active/paused/archived`, pause reason, issue prefix + counter, monthly budget/spent, `require_board_approval_for_new_agents`                                                                                                                            |
| `agents`                                         | name, role, title, `reports_to` (no cycles, same company), capabilities text, status `active/paused/idle/running/error/pending_approval/terminated`, `adapter_type`, `adapter_config`, `runtime_config` (heartbeat policy), monthly budget/spent, `last_heartbeat_at` |
| `goals`                                          | title, level `company/team/agent/task`, `parent_id`, owner agent, status `planned/active/achieved/cancelled`. At least one root company goal                                                                                                                          |
| `projects`                                       | goal link, lead agent, status, target date, env overlay                                                                                                                                                                                                               |
| `issues` (tasks)                                 | project/goal/parent links, status `backlog/todo/in_progress/in_review/done/blocked/cancelled`, priority, single assignee (agent or user), checkout/execution locks, `work_mode` `standard/ask/planning`, review policy, billing code                                  |
| `heartbeat_runs`                                 | agent, source `scheduler/manual/callback`, status `queued/running/succeeded/failed/cancelled/timed_out`, context snapshot, usage, session state                                                                                                                       |
| `agent_wakeup_requests`                          | the durable wake queue: source, reason, payload, status, `coalesced_count`, idempotency key, claimed/finished timestamps                                                                                                                                              |
| `cost_events`                                    | agent, issue, project, goal, provider, model, input/output tokens, `cost_cents`, `occurred_at`                                                                                                                                                                        |
| `budget_policies`                                | scope `company/agent/project` + id, metric `billed_cents`, window `calendar_month_utc/lifetime`, amount, `warn_percent` (80), `hard_stop_enabled`                                                                                                                     |
| `budget_incidents`                               | policy, window, threshold `soft/hard`, observed vs limit, status `open/resolved/dismissed`, linked approval                                                                                                                                                           |
| `approvals`                                      | type `hire_agent/approve_ceo_strategy/budget_override_required/request_board_approval`, status `pending/revision_requested/approved/rejected/cancelled`, payload, decision note; plus threaded `approval_comments`                                                    |
| `routines` + `routine_triggers` + `routine_runs` | recurring work: cron / webhook / API triggers, concurrency policy (`coalesce_if_active`), catch-up policy (`skip_missed`), variables, revisions. Each firing creates an issue and wakes the assignee                                                                  |
| `activity_log`                                   | actor type/id, action, entity, details. Every mutation writes one                                                                                                                                                                                                     |

The schema folder has about 150 tables in total. Most of the rest serve surfaces built on top of
this core: chat channels, plugins, environments, watchdogs, decisions, pipelines and so on.

### Heartbeat loop

`server/src/index.ts` runs `heartbeat.tickTimers()` on an interval. For every agent in an active
company, the tick checks the following in order:

1. Is the agent invokable? Not paused, terminated or pending approval, and its manager chain is not
   paused either.
2. Parse the heartbeat policy from `runtime_config.heartbeat`: `enabled` and `intervalSec` (at
   least 30).
3. Has `now - last_heartbeat_at` passed `intervalSec`? If so, atomically claim the due timer, so two
   server processes cannot both fire it.
4. `enqueueWakeup(agentId, {source:"timer"})`. If a live queued or running wake already exists for
   the agent, the new wake is **coalesced** into it (`coalesced_count++`) instead of starting
   another run.

The same `enqueueWakeup` path handles the other wake reasons: task assignment, @-mentions,
comments, approval decisions, routine firings and manual invokes (`wakeOnDemand`, on by default).
A dispatcher claims queued wakes. It then runs `budgets.getInvocationBlock()` (company pause, then
company policy, agent pause, agent policy, project policy), resolves the workspace, injects secrets
and skills, and calls the adapter's `execute()`. Afterwards it stores the logs, the usage (which
becomes a cost event) and the session params so the next run can resume. Orphaned runs are recovered
on startup. `heartbeat.ts` alone is 29,750 lines, most of it recovery and liveness edge cases.

### Budget enforcement

A cost event runs through `budgetService.evaluateCostEvent`. For each active policy that matches
the event (company, the event's agent, the event's project), it sums `cost_events` over the policy
window:

- If the sum reaches `warn_percent`, it opens a **soft** incident (deduplicated per window) and
  writes an activity entry.
- If the sum reaches the full amount and `hard_stop_enabled` is set, it resolves the soft incident
  and opens a **hard** incident. That creates a `budget_override_required` approval, sets the scope
  to `paused` with reason `budget`, and cancels the scope's queued work.

Before every invocation, `getInvocationBlock` checks the same limits again, so a stale queue cannot
get past a stop. The board resolves an incident in one of two ways:

- `raise_budget_and_resume`: the new amount must be above observed spend. The scope is unpaused and
  the approval is marked approved.
- `dismiss`: the scope stays paused.

### Approval flow

1. Someone creates an approval row: an agent through its API key, or the board.
2. The board approves, rejects or requests a revision. Revisions can be resubmitted with a new
   payload. Comments are threaded.
3. Approving a `hire_agent` approval activates the pending agent, or creates one from the payload,
   and gives it an agent budget policy. Approving a `budget_override_required` approval goes through
   incident resolution.
4. Waiting agents are woken with `PAPERCLIP_APPROVAL_ID` and `PAPERCLIP_APPROVAL_STATUS` in their
   environment.

The board can pause, resume or terminate any agent at any time. Termination is irreversible.

### Adapter contract

The contract is `ServerAdapterModule { type, execute(ctx), testEnvironment(ctx), sessionCodec?, listModels?, listSkills?, syncSkills?, onHireApproved?, getQuotaWindows? }`.

- `execute` receives `{runId, agent, config, context, onLog, onMeta, signal, authToken, runtimeTools}`.
  It returns `{exitCode, timedOut, errorMessage, usage, sessionParams, provider, model, costUsd, resultJson, summary}`.
- **process**: spawns `command args` with `PAPERCLIP_*` env and a run JWT, streams stdout/stderr and
  applies a timeout (SIGTERM, then SIGKILL after a grace period).
- **http**: POSTs `{...payloadTemplate, agentId, runId, context}` through a DNS-pinned SSRF guard.
  Private addresses are refused unless the operator allowlists the origin. A 2xx response means
  "accepted".
- **claude_local**: `claude --print --output-format stream-json --verbose [--resume <session>] --model … --max-turns … --append-system-prompt-file … --mcp-config …`.
  The stream-json output is parsed for session id, assistant text, `modelUsage` token totals and
  login, quota or transient-error signatures.
- **codex_local**: `codex exec --json …`. **cursor**: `cursor-agent -p --output-format stream-json --workspace …`.
  **gemini**: `gemini --output-format stream-json`.
- External adapter plugins register into a mutable server and UI registry (`adapter-plugin.md`).

Agents talk back through REST using the injected `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (run
JWT), `PAPERCLIP_AGENT_ID` and `PAPERCLIP_TASK_ID`. The `skills/paperclip/SKILL.md` runtime skill
teaches them the protocol: check out, comment, set status, delegate by creating subtasks.

## 3. Feature table

Verdict key: **adopt** means port the idea, **improve** means port it and make it better through
existing Nexus systems, **skip** means don't build it. Nexus paths are relative to `apps/api/src/`
unless they start with `packages/` or `apps/`.

| #   | Paperclip feature                                                                                                          | Nexus equivalent                                                                                                                                                                                          | Gap                                                | Verdict + why                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Companies** (multi-org, isolation, pause)                                                                                | None. Per-user scoping only (`lib/owner.ts`, `PersistentStore.for`). `routes/workspaces.ts` is a team-membership concept, not an org of agents                                                            | No org container for agents, goals or budgets      | **improve**: a company is a per-user container (`user::company`). One user can run several, and nothing crosses users                                                                                                                    |
| 2   | **Org chart**: roles, titles, `reports_to`, capabilities, cycle check, SVG chart                                           | Archetypes (`lib/archetype-store.ts`) are personas with a model and temperature, but have no hierarchy                                                                                                    | No agent-as-employee, no reporting lines           | **improve**: agents reference an archetype for persona and model, so the council and the org share one identity registry. Org tree UI plus reporting-line delegation                                                                     |
| 3   | **Agent lifecycle**: status machine, pause/resume/terminate, `pending_approval`                                            | Missions have status (`lib/mission-store.ts`), but there is no long-lived agent entity                                                                                                                    | Nothing to pause, resume or terminate              | **adopt**: Paperclip's status machine as written                                                                                                                                                                                         |
| 4   | **Goals hierarchy** (company → team → agent → task) plus goal ancestry in context                                          | Missions carry one goal string; autopilot has an objective                                                                                                                                                | No hierarchy, no "why" chain                       | **improve**: goals tree, with the ancestry injected into every run prompt _and_ recalled from memory (`lib/mission-memory.ts`)                                                                                                           |
| 5   | **Tasks/issues**: status machine, priority, parent, single assignee, atomic checkout, comments                             | `runtime_tasks` table (governance unblock only); session graph                                                                                                                                            | No task board                                      | **adopt**: task entity plus comments, with atomic checkout under `lib/with-key-lock.ts`                                                                                                                                                  |
| 6   | Blockers, documents, attachments, work products, labels                                                                    | Project files (`api-bridge` `project-files` store), Drive (`routes/drive.ts`)                                                                                                                             | Partial                                            | **adopt** blockers + work products (a run's output is attached to its task). **Skip** document annotations and revision locks: too heavy for the value                                                                                   |
| 7   | **Work modes** (`standard/ask/planning`) plus plan approval                                                                | Autopilot's architect phase plans implicitly                                                                                                                                                              | No explicit plan gate                              | **improve**: a planning-mode task produces a plan, and the plan is approved through a **council vote** or by the human                                                                                                                   |
| 8   | **Heartbeats**: timer scheduler, wake queue with coalescing, wake on assign/mention, run records                           | `lib/cron.ts` (connector sync only), `lib/agent-queue.ts`, missions                                                                                                                                       | No scheduled agent runs                            | **improve**: a heartbeat scheduler on `lib/cron.ts` (cron _or_ interval), a durable wake queue with coalescing, and run records that link to request traces                                                                              |
| 9   | Session persistence across heartbeats                                                                                      | Mission memory, threads                                                                                                                                                                                   | Nothing ties runs of one agent together            | **improve**: native agents resume from mission memory, and CLI adapters resume with `--resume <session>`                                                                                                                                 |
| 10  | **Budgets**: company/agent/project policies, warn %, hard stop, pause and cancel queued work, incidents, override approval | `routes/costs.ts` `/costs/limits` is env-based and "reported, not enforced". `lib/cost-log.ts` has spend per user and model. `packages/budget-manager`, `packages/token-budget` are unused or partly used | No enforcement at all                              | **improve**: policies and incidents over `cost-log`, with hard stops enforced _before_ the LLM call inside the failover driver path. That covers every model call an agent makes, not just adapter runs                                  |
| 11  | Cost events by agent/project/goal/provider/model                                                                           | `lib/cost-log.ts` (userId, model, tokens, USD), `lib/request-traces.ts` (per-request steps)                                                                                                               | No agent or project attribution                    | **improve**: extend `CostEntry` with `companyId/agentId/projectId/taskId/runId` through `lib/user-context.ts` AsyncLocalStorage, so attribution is automatic                                                                             |
| 12  | **Approvals**: hire, strategy, budget override, board request; revision, comments                                          | `routes/governance.ts` (`approval_requests`, **not scoped per user**), `lib/exec-approvals.ts` (per-user exec approvals)                                                                                  | Governance route leaks across users                | **improve**: one per-user approval inbox for hire, budget, strategy and exec. Optional **council pre-review**: the council deliberates on the request and attaches its verdict before the human decides. Fix the governance scoping hole |
| 13  | Activity log with actor attribution                                                                                        | `lib/audit-emitter.ts` (hash-chained `audit_log`), notifications store                                                                                                                                    | Not per company, no agent actor                    | **adopt**: company activity feed, also written to the audit chain                                                                                                                                                                        |
| 14  | **Routines**: cron/webhook/API triggers, concurrency and catch-up policies, each firing creates a task                     | `lib/cron.ts` (connector schedules), workflows (`routes/workflows.ts`)                                                                                                                                    | No recurring agent work                            | **adopt**: routines as heartbeat triggers that create a task. Webhook trigger with HMAC signing                                                                                                                                          |
| 15  | **Adapters**: process, HTTP, Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, Hermes, OpenClaw                            | Native LLM drivers (`packages/llm-drivers`), sandbox, local PTY (`routes/local-pty.ts` + `lib/exec-guard.ts`)                                                                                             | Cannot drive external agents                       | **improve**: `nexus` (native, BYOK + failover + council + memory), `claude_code`, `codex`, `gemini`, `opencode`, `shell`, `http_webhook`. Every local spawn passes `guardExec`, and every URL passes `pinnedFetch`                       |
| 16  | Agent API keys plus run-scoped JWT; agents call back into the API                                                          | PATs (`lib/pat-store.ts`, `nxk_`)                                                                                                                                                                         | No run-scoped credential                           | **adopt**: a short-lived run token that can only touch the run's own task                                                                                                                                                                |
| 17  | Execution workspaces (git worktrees), runtime services, preview URLs                                                       | per-agent workspace dirs (the worktree package was removed unused)                                                                                                                                        | Partial                                            | **improve** (later): an agent run's cwd is a per-task workspace dir. **Skip** preview-server supervision                                                                                                                                 |
| 18  | Task watchdogs, liveness, self-healing recovery                                                                            | none                                                                                                                                                                                                      |                                                    | **improve** (small): stale-run reaper plus an optional watchdog agent that re-checks "done" claims. **Skip** the 29k-line liveness machine                                                                                               |
| 19  | Secrets with per-agent bindings                                                                                            | `routes/secrets.ts` + `lib/secret-store.ts` (per user, fingerprint-only reads)                                                                                                                            | No per-agent binding                               | **adopt**: an agent config lists the secret names it may receive. They resolve server-side only                                                                                                                                          |
| 20  | Skills manager / Skill Studio / skills catalog; runtime skill injection                                                    | `routes/skills.ts`, `lib/skill-runner.ts` (store, merge, compress, embed, pre-execute)                                                                                                                    | Nexus is ahead here                                | **improve**: agents get skills attached. Nexus's embedding relevance and pre-execution already exceed Paperclip's                                                                                                                        |
| 21  | Company templates, teams catalog, import/export with secret scrubbing                                                      | Marketplace installs (`routes/marketplace.ts`)                                                                                                                                                            | No org templates                                   | **adopt**: export and import a company as JSON (agents, goals, routines, no secrets), plus built-in templates                                                                                                                            |
| 22  | Plugins (out-of-process workers, UI slots)                                                                                 | `packages/plugin-sdk`, `routes/plugin-registry.ts`, marketplace                                                                                                                                           | Comparable                                         | **skip**: Nexus already has a plugin path                                                                                                                                                                                                |
| 23  | MCP tool gateway, connected apps                                                                                           | `routes/mcp.ts`, `routes/mcp-servers.ts`, `packages/mcp-client`                                                                                                                                           | Comparable                                         | **skip**                                                                                                                                                                                                                                 |
| 24  | Chat channels (Slack, Discord, Teams, Telegram, GitHub, iMessage, email)                                                   | `packages/bots`, `routes/bots.ts`, mail ingest                                                                                                                                                            | Partial                                            | **skip** for now: large surface, low value next to the core. Notifications cover the key signal                                                                                                                                          |
| 25  | Dashboard: agents by status, tasks by status, pending approvals, spend, 14-day run activity; "What needs me" inbox         | `apps/ui/app/routes/home.tsx` dashboard, notifications                                                                                                                                                    | No org view                                        | **improve**: a company dashboard that answers _what is happening, does it need me, what do I do_, mobile-first                                                                                                                           |
| 26  | Mobile-friendly board                                                                                                      | Responsive UI in places; `docs/design/nexus-mobile.md`                                                                                                                                                    |                                                    | **improve**: the company pages are designed at 375px first                                                                                                                                                                               |
| 27  | Evals and feedback, decision training                                                                                      | `routes/evals.ts`, `routes/rlhf.ts`, feedback                                                                                                                                                             | Comparable                                         | **improve** (small): per-agent performance review, meaning run success rate, cost per finished task and a council-graded sample of outputs                                                                                               |
| 28  | Pipelines / cases (work queues)                                                                                            | Workflows DAG                                                                                                                                                                                             |                                                    | **skip**: workflows plus routines cover it                                                                                                                                                                                               |
| 29  | Multiple human users, invites, memberships                                                                                 | Workspaces (`routes/workspaces.ts`)                                                                                                                                                                       |                                                    | **skip** for now. Companies stay single-owner. Sharing a company through workspaces is a later step                                                                                                                                      |
| 30  | Board chat / "CEO chat" (roadmap)                                                                                          | Deliberations, discussion                                                                                                                                                                                 |                                                    | **improve**: "Ask the org" runs a council among the company's agents, and the verdict turns into tasks                                                                                                                                   |
| 31  | Memory / knowledge (Paperclip roadmap, _not built_)                                                                        | Memory, KBs, KG, mission memory                                                                                                                                                                           | Nexus is ahead                                     | **improve**: each agent gets a memory namespace, and finished tasks are distilled into company memory. This is "automatic organizational learning", which is on Paperclip's roadmap and unbuilt                                          |
| 32  | Cloud sandboxes (e2b, Daytona, Modal, Cloudflare)                                                                          | `packages/sandbox` (vm + Pyodide), Piston                                                                                                                                                                 |                                                    | **skip**: local sandbox plus exec-guard is enough for now                                                                                                                                                                                |
| 33  | OpenTelemetry, Sentry, telemetry                                                                                           | `packages/llm-tracer` (OTLP), `lib/sentry-reporter.ts`                                                                                                                                                    | Comparable. Paperclip's telemetry is on by default | **skip**: Nexus sends no default telemetry, and that stays                                                                                                                                                                               |
| 34  | Desktop app (Paperclip roadmap, _not built_)                                                                               | `apps/desktop` (Electron + pglite, offline)                                                                                                                                                               | Nexus is ahead                                     | **improve**: the org runs fully offline on desktop with Ollama                                                                                                                                                                           |
| 35  | CLI (`paperclipai onboard`, heartbeat-run, routines)                                                                       | `apps/cli`                                                                                                                                                                                                |                                                    | **adopt** (small): `nexus org` commands for status, invoke and approve                                                                                                                                                                   |
| 36  | Issue prefixes / identifiers (`ACME-12`)                                                                                   | none                                                                                                                                                                                                      |                                                    | **adopt**: cheap, makes tasks referable                                                                                                                                                                                                  |

## 4. Where Nexus should be better than Paperclip

Paperclip is deliberately model-agnostic, so it cannot see inside a run. Nexus owns the model layer,
and that is the advantage to build on:

1. **Budget stops happen before the call.** Paperclip learns about spend after an adapter reports
   it, so a single run can overshoot. For native agents, Nexus can refuse the next model call
   mid-run, because every call passes the failover driver and is attributed through AsyncLocalStorage.
2. **Council-reviewed governance.** An approval can carry a council verdict: several models with
   different personas assess a hire, a plan or a spend request before the human decides. Paperclip's
   approvals are a bare yes or no.
3. **BYOK failover for agents.** A native agent's calls use the owner's keys and fail over across
   providers. That addresses the Groq free-tier flake that already hits autopilot.
4. **Memory that compounds.** Agents recall prior task outcomes (mission memory plus the memory
   store), and finished work is distilled into company knowledge. Paperclip lists this on its
   roadmap and has not built it.
5. **Traces per run.** Every heartbeat run links to its request traces (model, tokens, latency,
   failover attempts), so "why did this cost $2" has an answer. That requires traces to persist
   rather than live in memory, which is also an open item in STATUS.md.
6. **Offline.** The whole company runs on the desktop build with pglite and Ollama.

## 5. What Nexus has

The adopt and improve rows above now exist as the **org layer**: `apps/api/src/lib/org-*.ts`, served
by `apps/api/src/routes/org*.ts` under `/api/org/*`, with the UI at `/org`
(`apps/ui/app/routes/org.tsx` and `apps/ui/app/components/org/`). Every row carries its owner's id
and every read filters on it; state lives in `PersistentStore` collections (`org_*`), so it runs
unchanged on Postgres, on the desktop's PGlite, or on JSON files. Files that port Paperclip logic
carry its MIT notice.

| Paperclip feature                                                           | Nexus implementation                     | Beyond Paperclip                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Companies, org chart, agent lifecycle (#1–3)                                | `org-store.ts`                           | Many companies per user; terminating a manager re-parents its reports; agents take an archetype as their persona                                                                                                                                                                     |
| Goals, tasks, checkout, blockers, comments, identifiers (#4–6, #36)         | `org-work.ts`                            | The "why" chain (task → parents → goals → mission) goes into every prompt; a delegated parent unblocks and wakes its owner when its subtasks finish                                                                                                                                  |
| Work modes and plan approval (#7)                                           | `org-work.ts`, `org-approvals.ts`        | Plans come back through a revision loop; the council can review a plan before the board does                                                                                                                                                                                         |
| Heartbeats, wake queue with coalescing, run records, orphan recovery (#8–9) | `org-runtime.ts`, `org-scheduler.ts`     | A timer wake is skipped when the agent has nothing to do, so an idle org costs nothing; a manager files itself a review only when its team has work waiting; every run keeps its model calls as a durable trace and can be replayed on another model with the answers diffed         |
| Budgets with warn and hard stop, incidents, override (#10–11)               | `org-budget.ts`                          | The limit is checked **before each model call** at worst-case cost; failover skips a provider that would cross it, so a run cannot overshoot; goal-scoped budgets; a spend forecast dates when each limit runs out; a daily inbox gathers what waits on the owner with no model call |
| Approvals: hire, budget override, plan, agent request (#12)                 | `org-approvals.ts`, `org-inbox.ts`       | Optional council pre-review on the owner's own models; command approvals from the exec gate share the same inbox; the daily inbox approves, unblocks and reassigns in place                                                                                                          |
| Activity log (#13)                                                          | `org-store.ts`                           | Governance actions also go to Nexus's hash-chained audit log                                                                                                                                                                                                                         |
| Routines: cron, webhook, concurrency (#14)                                  | `org-scheduler.ts`                       | The webhook secret is encrypted at rest, and signatures are timestamped and remembered across restarts against replay                                                                                                                                                                |
| Adapters: Claude Code, Codex, Gemini, OpenCode, shell, HTTP (#15)           | `org-adapters.ts`, `org-cli-adapters.ts` | The built-in `nexus` adapter uses the owner's keys with failover. Every process passes the exec policy once per agent and command; the child gets no server environment; webhooks go through the DNS-pinned SSRF guard                                                               |
| Per-agent secrets (#19)                                                     | `org-cli-adapters.ts`                    | Bound names resolve server-side into the child's environment or into `secret:NAME` header values                                                                                                                                                                                     |
| Company portability and templates (#21)                                     | `org-portability.ts`                     | Three built-in templates                                                                                                                                                                                                                                                             |
| Dashboard, mobile board (#25–26)                                            | `org-overview.ts`, `OverviewPanel.tsx`   | Designed at 375px first; a portfolio strip across companies                                                                                                                                                                                                                          |
| Agent evals and performance (#27)                                           | `org-performance.ts`, `org-replay.ts`    | Council review of an agent's recent output; a per-agent model scorecard from real runs and replays names a cheaper model that agrees, and a company can opt in to move agents there itself, logged once per move and undone from the agent's sheet                                   |
| CEO chat (roadmap #30)                                                      | `askOrg` in `org-runtime.ts`             | The answer arrives in a task thread, as Paperclip's roadmap intends                                                                                                                                                                                                                  |
| Memory / organizational learning (roadmap #31)                              | `org-memory.ts`                          | Paperclip has not built this. Lessons are captured with no model call and recalled offline, and mirrored to Nexus memory when it can embed; a discussion's decision is kept with how it ended                                                                                        |
| Self-organization (roadmap)                                                 | `org-runtime.ts` + `org-approvals.ts`    | An agent proposes a hire; the hire always waits for the board                                                                                                                                                                                                                        |
| Task watchdog (#18, reduced)                                                | `reapStalled` in `org-runtime.ts`        | Closes runs that outlive their deadline and frees their task and slot                                                                                                                                                                                                                |
| CLI (#35)                                                                   | `apps/cli/src/lib/org.ts`                | `nexus org status / companies / inbox / ask / approve / reject / wake`; `inbox` approves, rejects, unblocks, accepts and reassigns from the terminal                                                                                                                                 |

Also new: @-mentions in board comments pull another agent in with an answer-only subtask, and two
to five agents can discuss a task in its thread (`org-discussion.ts`, on the council debate) until
they agree or three rounds pass, in parallel or turn by turn; an agreed decision becomes a subtask
for the most senior agent, and when that subtask is done or dropped the thread hears how it ended.
A whole task can be replayed on another model, run by run, comparing cost and reported status
(`replayTask` in `org-replay.ts`); those replays feed each agent's model scorecard.

### The org as the spine of Nexus

Paperclip is a standalone control plane; in Nexus the org layer is wired into the features around it.

| Nexus feature        | How it meets the org                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows            | A Company Task step files the step's data as a task and can wait for the agent's deliverable                                                                                             |
| Council (chat)       | A verdict can be sent to a company; its top agent splits it into work                                                                                                                    |
| Knowledge bases      | An agent reads the knowledge bases picked for it, plus the owner's personal memory, on every run                                                                                         |
| Skills               | Attached skills run once before each turn, through the exec gate, and their output goes into the prompt                                                                                  |
| Council (governance) | Beyond approvals, the council can check work an agent calls done before it counts                                                                                                        |
| Model routing        | A `nexus` agent may name a cheaper quick model for answer-only tasks and triage                                                                                                          |
| Projects             | A project handed to a company becomes one of its goals; work asked for there lands under it                                                                                              |
| Dashboard, digest    | Both summarise every company: agents working, month spend, decisions waiting                                                                                                             |
| Workspaces           | A company can be shared with a workspace (`/workspaces`); members read, comment, file and reassign tasks, with the fields each change may carry enforced in one table; viewers only read |
| Autopilot            | Removed. Its architect, coder and reviewer loop is a Software team company with budgets, approvals and memory                                                                            |

### Skipped, and why

- **Plugin system, MCP tool gateway (#22–23):** Nexus already has both.
- **Chat channels (#24):** a large surface for little value next to the core; notifications carry the key signal.
- **Execution worktrees and preview servers (#17):** each agent gets its own persistent workspace directory instead. The old worktree fan-out (`packages/agent-orchestrator`) was removed: nothing started it.
- **Paperclip's liveness engine:** replaced by the small watchdog above plus blocker-driven unblocking.
- **Run-scoped API tokens for agents (#16):** agents report back through the outcome block on stdout, so no credential ever enters the child process.
- **Syncing companies between the desktop and a server:** keys sync, but a company's tasks, runs
  and budgets change on both sides at once and have no safe automatic merge; export and import
  move a company instead.
- **Multi-human companies (#29), cloud sandboxes (#32), default-on telemetry (#33), document annotations, labels, billing codes, pipelines and cases (#28).**

### Still open

- Workspace members may comment, file tasks and reassign them; approvals, budgets, hires, replay,
  discussions and exports stay with the owner. Multi-human companies (#29) with several owners
  remain skipped.
- An agent still cannot call back into the API mid-run (see run tokens above). A CLI run's parsed
  tool calls and messages stream into its run log, but the outcome is applied at the end. This is
  deliberate: the outcome block gives the same result without a credential in the child.
- A member's writes and each company's `can` set come from one table in `routes/org-http.ts`;
  multi-owner companies are still skipped.
- Agreement in a discussion is scored by word overlap on each agent's one-line decision, so
  synonyms read as disagreement (see Known caveats in `docs/STATUS.md`).
