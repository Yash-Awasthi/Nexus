# NEXUS — Execution Plan (Finish Line → Roadmap)

> Authored: 2026-06-26 · Branch: `main` · HEAD: `4cb94dd`
> Supersedes the scattered next-steps in `RESUME.md` / `NEXT_PLAN.md` for the **finishing effort**.
> `FUTURE_PLAN.md` remains the source of truth for the long-horizon Phases 6–8.

---

## 0. Verified status snapshot (live, 2026-06-26)

Checked against the repo + GitHub API today, not from memory:

| Signal              | State                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| CI on `main` (HEAD) | ✅ **all green** — Build & Typecheck, Test, Lint, Security, Docker, CodeQL, Release |
| Coverage            | ~90.6% (prior measurement; unverified this session)                               |
| Open CodeQL alerts  | ⛔ **47 open** (2 critical, 43 high/med, 2 note/warning)                            |
| Open PRs            | ✅ none (all dependabot PRs merged/closed)                                          |
| Branches            | ✅ only `main` (cleanup done)                                                       |
| Worker hosting      | ⛔ **runs on laptop only** — Railway service not yet created                        |
| Deploy targets      | API+UI on Railway (`railway.toml`); `fly.toml` + `render.yaml` also present        |
| Live stack          | API (Render `nexus-api-8xr0`) + UI (Vercel) + Neon PG + Redis Cloud + Browserbase  |

**Definition of "done" (portfolio-grade):** CI green · 0 open CodeQL alerts (fixed or
formally dismissed with rationale) · worker hosted so async jobs run without a laptop ·
security-sensitive code covered by regression tests. Phases 6–8 + Nexus Drive are a
**separate, larger build** — explicitly out of scope for the finish line.

---

## Horizon 1 — Finish Line (close the gap to "done")

Five workstreams. W1+W2 are the bulk (the 47 alerts). All of H1 except W3 is code-only
and fully in our control. W3 needs the user's Railway account.

### W1 — CodeQL: rate-limiting (24 alerts → fix)

The limiter infra already exists (`apps/api/src/lib/rate-limiter.ts`:
`makeRateLimitPreHandler`, `makeUserRateLimitPreHandler`). In `server.ts` the handlers
`_adminRL` / `_billingRL` / `_codeReplRL` are **created but underscore-prefixed (not
attached)** — that is the gap. Fix = attach a limiter `preHandler` to each flagged route.

Flagged routes (attach limiter to each):

- `api-bridge.ts` — #1517-1529 (13 routes, L8871–9095: contacts/archetypes/leaderboard/traces)
- `drive.ts` — #1566 (L134), #1534 (216), #1535 (257), #1536 (284), #1567 (325)
- `sse.ts` — #1539 (98), #1540 (158), #1541 (227), #1542 (251)
- `oauth.ts` — #1516 (347)
- `server.ts` — #1543 (373)

**Approach:** define a small set of named limiters (publicRL, authedRL, sseRL, driveRL)
once, and compose into each route's `preHandler` array. Prefer `makeUserRateLimitPreHandler`
(per-user) on authed routes, IP-based on public ones. Don't hand-roll per-route configs.

**Acceptance:** every flagged route has a limiter preHandler; `pnpm --filter @nexus/api
typecheck` + lint clean; on next CodeQL scan all 24 close.

### W2 — CodeQL: injection / path / misc (23 alerts → triage: fix or dismiss-with-rationale)

Each alert triaged individually — **no blanket dismissal**. Categories:

| #              | Rule                            | Location                       | Verdict & action                                                                                                |
| -------------- | ------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1547           | command-line-injection (crit)   | drive.ts:170                   | **Real-ish.** Drive runs user shell cmds *by design*; risk is the **host fallback** `spawn("/bin/sh"...)`. Fix: never run the unsandboxed fallback in prod (gate on `NODE_ENV`/throw), or remove it. Then re-scan. |
| 1548, 1560     | command/indirect-cmd-injection  | sandbox/index.ts:211           | **False positive.** `spawn(cmd, args)` — array args, **no shell**. Add clarifying comment; dismiss via API.      |
| 1549-1555      | path-injection (7)              | drive.ts (87,171,224,231,267,307,308) | **Guarded** by `safeResolve()`. Make the guard CodeQL-recognizable (realpath + boundary assert that sanitizes), else dismiss with rationale. |
| 1544, 1545     | resource-exhaustion             | drive.ts:181, sandbox:205      | Output already clipped (`clip`/`MAX_OUTPUT_BYTES`). Confirm cap precedes accumulation; dismiss or tighten.       |
| 1556, 1558     | http-to-file / insecure-temp    | drive.ts:308                   | Inspect download/export path; use a safe temp dir + validated path. Fix.                                         |
| 1561           | unreachable-statement (warn)    | drive.ts:269                   | Dead code — **delete**.                                                                                          |
| 1546           | insufficient-password-hash      | crypto-utils.ts:11             | Inspect: scrypt is fine; if a weak hash is used elsewhere here, fix. Likely add iteration/param note or dismiss. |
| 1532           | unvalidated-dynamic-method-call | provider-keys.ts:103           | Add an **allowlist** for the dynamic method/key before dispatch. Fix.                                            |
| 1559           | user-controlled-bypass          | sse.ts:254                     | Inspect auth/tier check; ensure no user-controlled value bypasses it. Fix.                                       |
| 1515           | xss-through-dom                  | scrape.tsx:324                 | Sanitize/escape rendered scraped content (textContent or DOMPurify). Fix.                                        |
| 1565           | reflected-xss                   | api-bridge.ts:9162             | Escape/encode reflected input in response. Fix.                                                                  |
| 1564           | bad-tag-filter                  | api-bridge.ts:3664             | Replace fragile tag regex with a robust parser/escape. Fix.                                                      |
| 1557           | file-system-race                | scripts/scaffold.ts:35         | Dev-only scaffold script. Fix (atomic create) or dismiss as non-runtime tooling.                                |
| 1563           | unused-local-variable (note)    | archetypes.tsx:376             | **Delete** the variable.                                                                                         |

**Dismiss command (for true false-positives only):**
`gh api -X PATCH repos/Yash-Awasthi/Nexus/code-scanning/alerts/<N> -f state=dismissed -f dismissed_reason="false positive" -f dismissed_comment="<rationale>"`

**Acceptance:** every alert in W1+W2 is either code-fixed (closes on re-scan) or dismissed
with a written rationale → `gh api .../code-scanning/alerts?state=open` returns **0**.

### W3 — Host the worker (needs user's Railway account)

Today all async jobs (agent.run, council, feeds, drive-exec) only run while the laptop
worker is up. Fix = a Railway `nexus-worker` service.

- Worker `Dockerfile` exists: `apps/worker/Dockerfile` (topo build + `pnpm deploy` prune).
- `railway.toml` documents the manual step: Railway UI → new service → Dockerfile path
  `apps/worker/Dockerfile` → set `REDIS_URL`, `DATABASE_URL`, `NEXUS_API_KEY`, provider keys.
- Must share the **same Redis + Postgres** as the API (Redis Cloud + Neon, or Railway plugins).

**Decision needed from user:** (a) provide a Railway API token in `.env` so this can be
automated, or (b) I produce exact click-by-click Railway UI steps for you to run.

**Acceptance:** enqueue a job via the API → worker (hosted) consumes → `job.completed`,
with the laptop terminal **closed**.

### W4 — Security regression tests (5 tests)

From `NEXT_PLAN.md` Priority 5 — lock in the W1/W2 fixes so they can't regress:

1. `apps/api/tests/routes/sse-tenant.test.ts` — SSE tenant isolation (ties to #1559)
2. `apps/api/tests/routes/drive.test.ts` — Drive path traversal + exec sandbox (ties to #1547-1555)
3. `apps/worker/tests/handlers/agent-tools.sandbox.test.ts` — sandbox env scrubbing (`buildSafeEnv`)
4. `apps/api/tests/lib/rate-limiter.atomic.test.ts` — atomic INCR limiter (ties to W1)
5. `apps/api/tests/routes/mcp-servers.ssrf.test.ts` — MCP SSRF URL validation

**Acceptance:** all 5 pass under `pnpm --filter @nexus/api test` / `@nexus/worker test`;
each asserts the **attack is blocked**, not just the happy path.

### W5 — Verify & land

1. `pnpm --filter @nexus/api typecheck && pnpm --filter @nexus/api lint` (+ worker)
2. Full `pnpm test` for touched packages
3. Branch (never commit to `main` directly) → conventional commits → push → PR
4. Watch CI green; confirm CodeQL re-scan drops open alerts to 0
5. Update this file's status snapshot

---

## Sequencing

```
W2(triage criticals + fixes) ─┐
W1(rate-limiting)            ─┼─► W5 verify+commit+push ─► CodeQL re-scan ─► dismiss residual FPs ─► 0 alerts
W4(regression tests)         ─┘
W3(worker hosting) ── parallel, gated on user's Railway decision
```

- W1, W2, W4 are independent and can run in parallel (touch mostly different files;
  `drive.ts` is shared by W1/W2 — coordinate edits there).
- W3 is independent of the code work; start once the user picks token-vs-manual.
- Dismissals (W2 false-positives) happen **after** the push, since CodeQL re-scans on push
  to `main` and auto-closes the genuinely-fixed alerts first.

---

## Risks

| Risk                                                   | Mitigation                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Dismissing a real vuln as "false positive"            | Per-alert triage with written rationale; fix-by-default, dismiss only array-spawn / proven-guarded cases |
| Rate-limiter breaks legit traffic / SSE long-poll      | Generous limits on SSE; per-user keys on authed routes; test in W4         |
| Drive host-fallback fix changes behavior in dev        | Gate on `NODE_ENV`; keep Docker path default; document in `DISABLE_DOCKER_SANDBOX` |
| Worker env drift (different Redis/PG than API)          | Reuse exact `REDIS_URL`/`DATABASE_URL` from API service                    |
| CodeQL re-scan lag                                      | Push, wait for scan, then dismiss residual; don't dismiss pre-emptively    |

---

## Horizon 2 — Roadmap (out of scope for the finish line)

Tracked in `FUTURE_PLAN.md`. Summary of what remains and what blocks it:

- **Phase 5e leftovers** (code-only, can fold into a later pass): seccomp profile,
  read-only rootfs, userns remap for the Docker sandbox; per-user API-key rate limiting.
- **Phase 6 — Nexus Drive** (flagship): per-user Firecracker microVM + 512 MB FS quota.
  **Blocked on a KVM host** (bare metal / nested-virt cloud VM). gVisor → Docker fallback
  is the degrade path. Large build, not a finishing pass.
- **Phase 7 — Production multi-tenant hardening:** PgBouncer, RS256 JWT, OTel tracing, K8s
  HPA, SLO dashboards, compliance. Mostly infra-gated.
- **Phase 8 — Marketplace + federation + desktop app.** Exploratory.
- **Package gaps:** `@nexus/video-transcript`, `@nexus/image-transformations`,
  `@nexus/leaderboard` live data, `@nexus/browser-agent` task/session mgmt.

---

## Immediate next action

Execute H1. Start W1 + W2 + W4 as a parallel code effort (orchestrated), land via W5.
W3 (worker hosting) proceeds in parallel pending the user's Railway token-vs-manual choice.
