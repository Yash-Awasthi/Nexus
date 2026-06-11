# Contributing to GhostStack

GhostStack is a local-first autonomous orchestration engine. This guide covers the development workflow, code standards, and contribution process.

---

## Development Setup

```bash
git clone https://github.com/Yash-Awasthi/Utills
cd Utills/projects/ghoststack
npm install
cp ghoststack.config.example.json ghoststack.config.json
cp .env.example .env   # fill in API keys as needed
```

**Optional: Floci (local AWS emulator)**

```bash
npm run start:federation   # starts Docker-based Floci
```

---

## Running Tests

```bash
npm test                   # full test suite
npm run test:watch         # watch mode
npm run test:coverage      # coverage report
```

All PRs must pass the full test suite with **zero new failures**.

**Running a single suite:**

```bash
./node_modules/.bin/jest tests/adapter-routing.test.ts --no-coverage
```

---

## Code Quality Gates

Before committing, run:

```bash
npm run typecheck          # zero TypeScript errors
npm run lint               # zero ESLint errors or warnings
npm test                   # all tests green
```

All three must be clean. CI enforces the same checks.

---

## Commit Message Convention

Use conventional commits:

```
type(scope): short description

Optional body explaining the why, not the what.

Co-Authored-By: ...
```

**Types:** `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `perf`

**Examples:**
```
feat(planning): add LLM-backed blueprint selection with keyword fallback
fix(runtime): remove offlineMode=true default when env var is unset
test(adapters): add T7 E2E routing tests for search/code/inference adapters
docs: update OPERATIONS.md to v1.2.0
chore: remove stale HTML artefacts and temp runtime dirs
```

---

## Branch Naming

```
feature/<short-description>    feat(...)
fix/<short-description>        fix(...)
test/<short-description>       test(...)
chore/<short-description>      chore(...)
```

---

## Project Structure

```
runtime/           Runtime entry points and orchestrator
  bootstrap.ts     One-shot demo bootstrap
  cli.ts           gs CLI (all commands)
  server.ts        HTTP API server entry
  orchestrator.ts  GhostStackOrchestrator core
  runtime-context.ts  Full wired runtime factory

orchestration/     Core domain: adapters, engines, interfaces
  interfaces/      TypeScript interfaces (all contracts live here)
  planning-engine.ts   Blueprint-based + LLM-backed planner
  governance-engine.ts Constraint/policy/guardrail evaluation
  task-executor.ts     Queue drain loop + adapter dispatch
  language-model.ts    GroqModelProvider + FreeModelProvider

tests/             Jest test suite (one file per domain)
schemas/           JSON schemas for tasks, agents, specs, MCP registry
specs/             Workflow spec YAML files (loaded at runtime)
docker/            Docker and docker-compose files
docs/              Architecture, benchmarks, operations, security
apps/floci/        Floci local AWS emulator (external dependency)
```

---

## Adding a New Execution Adapter

1. Create `orchestration/my-adapter.ts` implementing `IExecutionAdapter`:
   ```typescript
   import { IExecutionAdapter, IExecutionContext } from "./interfaces/execution.interface";
   export class MyAdapter implements IExecutionAdapter {
     canExecute(taskType: string): boolean {
       return taskType === "my-type";
     }
     async execute(task: any, _ctx: IExecutionContext): Promise<Record<string, unknown>> {
       // ...
       return { success: true };
     }
   }
   ```

2. Add a blueprint to `orchestration/planning-engine.ts`:
   ```typescript
   "my-blueprint": {
     label: "My Blueprint",
     templates: [{
       action: "my_action",
       defaultArguments: {},
       governanceMetadata: { dangerous: false, costEstimate: 0.01, resourceScope: "custom" },
       dependsOnActions: [],
       adapterType: "my-type"
     }]
   }
   ```
   Add `"my-blueprint"` to `PRIORITY_ORDER`.

3. Wire into `runtime/runtime-context.ts` — add to the `TaskExecutor` adapters array.

4. Add tests in `tests/` covering `canExecute`, adapterType threading, and E2E routing via spy.

---

## Adding a New CLI Command

Add a case to the `switch` block in `runtime/cli.ts`. Follow the existing pattern: create a runtime context, run the operation, call `stopRuntime`.

---

## Governance & Safety

All task execution goes through the governance engine. When adding dangerous operations:
- Set `governanceMetadata.dangerous = true` in the blueprint template.
- The `DangerousOperationPolicy` will require explicit approval before execution.
- Write a test that verifies the governance gate fires.

---

## Documentation

- Code changes that affect public behaviour require a `docs/` update.
- New CLI commands must appear in `docs/OPERATIONS.md`.
- `CHANGELOG.md` entries are required for every release.
- Internal design decisions go in `docs/architecture.md` or a new `docs/` file.
