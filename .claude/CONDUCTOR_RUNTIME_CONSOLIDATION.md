> ✅ **COMPLETED 2026-06-22** on branch `claudecode`. `@nexus/conductor` deleted; the single
> consumer (`conductor-route`) migrated to `@nexus/runtime` via `conductor-compat.ts`. Stage-0
> `/gs/*` regression oracle added. Verification gate green twice: typecheck 216/216, test
> 240/240, oracle 6/6. Commits: c18cf10 (oracle), e76d98d (Stage 1+2), 65aceea (Stage 4+5).
> Note: `/gs/submit` was already 500-ing pre-migration (planning/governance never registered);
> that latent bug is preserved, not introduced — fixing it is a separate follow-up.

# Plan: consolidate the `@nexus/conductor` ≈ `@nexus/runtime` twin packages

## Why this exists

`packages/conductor` (80 src files, ~18.6k LOC) and `packages/runtime` (74 src files,
~16k LOC) are near-duplicate "twin" packages. Measured overlap:

| File                 | conductor | runtime  | divergence                |
| -------------------- | --------- | -------- | ------------------------- |
| `workflow-engine.ts` | 1271 LOC  | 1272 LOC | ~4% (near-identical copy) |
| `runtime-graph.ts`   | 1103 LOC  | 1105 LOC | ~1% (near-identical copy) |
| `planning-engine.ts` | 435 LOC   | 609 LOC  | ~22% (runtime evolved)    |

53 same-named files exist in both; 3 are byte-identical, ~50 have drifted slightly.
This is real maintenance debt: bug fixes must be applied twice, and the two can silently
diverge in behavior.

## Why it was NOT auto-merged (important constraints)

1. **Different module systems.** `conductor` is `"type": "commonjs"`; `runtime` is
   `"type": "module"`. `apps/api/src/routes/conductor-route.ts` loads conductor with
   `createRequire(import.meta.url)("@nexus/conductor")` _specifically because it is CJS_.
2. **Different public APIs.** conductor-route uses conductor's low-level primitives:
   `ConductorOrchestrator.create({runtimeManager,eventBus,taskRouter,agentRegistry,queue})`,
   `PlanningEngine`, `GovernanceEngine`, `TaskRouter`, `LocalAgentRegistry`, `LocalEventBus`,
   `RuntimeManager`, `MemoryQueueBackend`. `runtime` does **not** export
   `ConductorOrchestrator` / `GovernanceEngine` / `TaskRouter` / `LocalAgentRegistry` /
   `RuntimeManager` by those names — it exposes a refactored façade (`createNexusRuntime`,
   `FederationSupervisor`, `CouncilBridge`, …). So the two are NOT drop-in compatible.
3. **No runtime verification available here.** The only consumer is a Fastify route that
   executes an orchestrator; correctness can't be proven by `build`/`typecheck` alone (the
   require is dynamic, typed via local interfaces) and there is no live Postgres/Redis in
   this environment to exercise it. A blind merge could pass CI and still break at runtime.

These three together make this a deliberate, staged refactor — not a safe one-shot edit.

## Consumers (the blast radius is small)

- `@nexus/conductor` is imported in exactly **one** place: `apps/api/src/routes/conductor-route.ts`
  (via dynamic CJS require). Declared dep in `apps/api/package.json`.
- `@nexus/runtime` is the maintained, widely-used twin: `apps/api/src/conductor-server.ts`,
  `apps/cli/src/runtime-cli.ts`, `packages/plugin-sdk`.

Conclusion: **runtime is canonical; conductor is a near-dead CJS fork with one consumer.**

## Recommended approach — make runtime the single source of truth

### Stage 0 — Lock behavior (safety net)

- Stand up infra: `docker compose up -d postgres redis`.
- Write/extend an integration test that drives `POST /api/gs/submit`, `/api/gs/status`,
  `/api/gs/health`, `/api/gs/dead-letter` against the current conductor-backed route and
  records expected responses. This is the regression oracle for every later stage.

### Stage 1 — Close the API gap in runtime

- Add the primitives conductor-route needs to `@nexus/runtime`'s public API, OR a thin
  compatibility entry (`runtime/src/conductor-compat.ts`) that re-exports/adapts:
  `ConductorOrchestrator` (or a `createNexusRuntime`-based shim exposing
  `.start()/.submitAndRun()/.getQueue()`), `TaskRouter`, `RuntimeManager`,
  `LocalAgentRegistry`, `LocalEventBus`, `GovernanceEngine`, `PlanningEngine`,
  `MemoryQueueBackend`.
- Resolve the **CJS/ESM** issue: `conductor-route.ts` is in the ESM api app, so it can
  `import` from ESM `@nexus/runtime` directly — drop the `createRequire` workaround.

### Stage 2 — Migrate the single consumer

- Rewrite `apps/api/src/routes/conductor-route.ts` to import from `@nexus/runtime`
  (static ESM import, remove `createRequire`/`GSModule` interface shims).
- Swap the dep in `apps/api/package.json`: remove `@nexus/conductor`, keep `@nexus/runtime`.
- Run Stage 0's integration test → responses must match the recorded oracle exactly.

### Stage 3 — Reconcile the diverged engines (do this BEFORE deleting conductor)

- Diff `planning-engine.ts` (the 22%-diverged file) between the two and decide which
  behavior is correct; port any conductor-only fixes into runtime. `workflow-engine.ts` and
  `runtime-graph.ts` are ~96–99% identical — verify the few differing lines are
  intentional/superseded, not lost fixes.

### Stage 4 — Delete conductor

- Remove `packages/conductor` entirely (and its `pnpm-workspace` membership is automatic).
- `pnpm install`, then full sweep: `pnpm build && pnpm typecheck && pnpm test` (expect the
  current 137 / 216 / 239 all-green to hold) + Stage 0 integration test.

### Stage 5 — Cleanup

- Remove any conductor-only docs/references; update README package count.

## Verification gate (every stage)

`pnpm build` (137 tasks) · `pnpm typecheck` (216) · `pnpm exec turbo run test --continue`
(239) must all stay green, plus the Stage-0 conductor-route integration test. Do not delete
conductor (Stage 4) until Stages 1–3 are green twice in a row.

## Estimated effort

Small blast radius (1 consumer) but real risk in Stages 1 & 3 (API shim + engine
reconciliation). ~0.5–1.5 days with infra available. Not suitable for unattended/auto
execution because the only correctness signal is a live-infra runtime test.
