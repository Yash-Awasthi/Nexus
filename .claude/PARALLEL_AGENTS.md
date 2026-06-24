# Running parallel & background agents on NEXUS

NEXUS is a 107-package monorepo, which makes it an ideal target for parallel agents:
most packages are independent, so work can be fanned out with little conflict.

## 1. Put Claude Code on Opus

Three ways (any one works):

- **Per project**: already set in `.claude/settings.json` → `"model": "opus"`.
- **This session**: type `/model opus` in the REPL.
- **Globally**: add `"model": "opus"` to `~/.claude/settings.json`.

Verify with `/model` (should report Opus 4.x).

> Note: this environment uses a custom `ANTHROPIC_BASE_URL` proxy. `opus` resolves
> to whatever Opus the proxy serves. If `opus` isn't accepted, set the full id, e.g.
> `claude-opus-4-8`.

## 2. Two flavors of "agents"

| | Subagents (Agent tool) | Background tasks |
|---|---|---|
| What | Spawned sub-Claudes with their own context | Long shell commands that run detached |
| Use for | Parallel coding/review/research across packages | `pnpm build`, `pnpm test`, dev servers |
| How | "Use N subagents to ..." or the Agent tool | `pnpm test &`-style, run in background |
| Concurrency | Many at once, results return to the lead | Re-invokes Claude when each finishes |

## 3. Parallel subagents — the core workflow

Because packages are isolated, give **one package (or app) per subagent**. Tell the lead
Claude something like:

> "Spin up parallel subagents, one per package, to <task>. Each subagent should
> `cd` into its package, run `pnpm --filter @nexus/<pkg> typecheck && pnpm --filter
> @nexus/<pkg> test`, and report back."

Good fan-out tasks here:
- **Typecheck/test sweep**: one subagent per package, collect failures.
- **Dependency/version bumps**: one per package, edit + verify in isolation.
- **Code review by dimension**: subagents for correctness / security / perf over a diff.
- **Doc/onboarding**: one subagent per app in `apps/` to summarize routes & flows.
- **Migration**: discover call sites, then one subagent per site to transform + verify.

### Avoid write conflicts
When subagents **edit files in parallel**, isolate them so they don't clobber each
other. Either scope each strictly to its own package, or run each in its own git
worktree (`isolation: "worktree"` on the Agent tool). Read-only fan-out (review,
typecheck, search) needs no isolation.

### Don't double-run
If you delegate a search/build to a subagent, wait for its result instead of also
running it yourself.

## 4. Background tasks — builds & long runs

Run slow, independent commands in the background so the lead keeps working:
- `pnpm build` / `pnpm test` (whole-repo) — minutes; background it.
- `docker compose up -d postgres redis` — infra for runtime work.
- `pnpm dev` — persistent dev servers.

Claude is re-invoked automatically when a background task finishes — no polling needed.

## 5. Suggested first run

```
docker compose up -d postgres redis          # infra (only for runtime work)
# then, in Claude Code (on Opus):
"Fan out parallel subagents, one per package under packages/, run
 `pnpm --filter @nexus/<pkg> typecheck` in each, and give me a table of
 which packages pass and which fail."
```

This gives a fast health map of the repo and exercises the parallel setup end to end.

## 6. Skills available

Curated skills are installed in `~/.claude/skills/` (code-reviewer, adversarial-reviewer,
api-design-reviewer, agent-designer, debugging-and-error-recovery, performance-profiler,
docker-development, codebase-onboarding, etc.). Invoke with `/<skill-name>` or let
Claude pick them up by description.
