# plan.md

merge done. branch `fresh` built off `ollama` tip (9418999), pulled in main + 2 live
dependabot branch (setup-node-7, setup-python-7, devdeps-50baa80161). 3 clean merge,
zero conflict. old dependabot branch from task note (24659e0b9c, ea593dfa71) gone from
remote already, replaced by these 3, so merged the ones that exist now.

push to origin blocked: PAT token missing `workflow` scope, github reject push that
touch `.github/workflows/*.yml`. branch `fresh` sit local only, not on origin yet.
man must bump token scope (repo settings → PAT → add `workflow`) then push:
`git push origin fresh`.

## hard call, not done, man pick

1. DEPLOY-DOC — two file, two truth. root `DEPLOYMENT.md` (8KB, interview/demo runbook,
   Vercel+Railway+Neon+Redis+Browserbase stack map) vs `docs/DEPLOYMENT.md` (4KB, env-var
   ref + link to `docs/runbook.md`). pick one master, kill other or link it.

2. BRANCH-FOLD — local-dirty vs main. confirmed: local-dirty = ollama + 1 commit
   (d78e459) that touch same 8 file as working-tree dirt, 0 insertion 0 deletion
   (filemode flip only, husky hooks + chaos/codegen script lost exec bit on windows
   checkout). no real diff. safe to drop, but man confirm.

3. STALE-BRANCH — `ollama`. no upstream tracking, orphan. fresh already carry all its
   commit. keep or delete, man decide (folded into fresh either way).

4. STALE-BRANCH x2 — old dependabot ref from task note (24659e0b9c, ea593dfa71) already
   gone from origin, superseded by 3 new dependabot branch. all 3 new one now merged
   into fresh, clean. nothing left to decide here, done.

5. DIRTY-STATE — 8 file (husky hook, chaos script, codegen, dev script, release script)
   flip exec bit on every windows checkout, filemode-only, no content change, no
   conflict marker. touches deploy/release/infra path so man still eyeball before
   trusting, but confirmed empty diff each time re-checked.

## what's broken / half-built (carried from ollama track notes, still true on fresh)

- GET surface: 242 route audited, several still 0x500 (memory embed on empty query,
  admin/traces) — partial fix landed (TRACK-006/007) but not full sweep.
- mail-ingest start path returns 503 not 500 when IMAP unconfigured — fixed, verify
  under real IMAP config still open.
- `_getPool` sentinel fix landed, raw-pg route confirmed alive, no regression test yet.
- Council deliberation: both the keyless local-Ollama fallback and the BYOK path
  for Groq, Gemini, Mistral, and OpenRouter have now been traced and verified.
  Two real bugs were found and fixed in the fallback/selection logic itself; see
  the verification pass below for the full account.
- UI agents + knowledge-graph crash fix (a5f0e9d) and JWT-on-raw-fetch fix (f2f6946)
  landed, no test added.

## Next steps

1. Add the `workflow` scope to the PAT, then push: `git push origin fresh`.
2. DEPLOY-DOC (hard call #1): resolved, see below.
3. Council deliberation fallback/selection logic (hard call #2): verified, and
   two bugs found in it were fixed. See the verification pass below.
4. Once `fresh` is pushed and merged into `main`, act on the branch-fold
   recommendation below (`ollama`, `local-dirty`).
5. `apps/api` still will not boot from this native-Windows checkout (see the
   verification pass below for the exact cause) — run from WSL, or run a full
   `pnpm install` on Windows first, before the next route-level check.

## 2026-08-16 verification pass

**Hard call 1 — DEPLOY-DOC, decided and executed** (reversible via git if this
call is wrong): kept `docs/DEPLOYMENT.md` as the master. It is what
`README.md`'s own docs table already links to, and it is the broader reference
(Docker Compose, Kubernetes, Terraform, observability), so it was already the
de facto canonical doc. Renamed root `DEPLOYMENT.md` to `REDEPLOY_RUNBOOK.md`
instead of deleting it — it holds real, non-duplicated operational content
(concrete deploy order, the smoke-test script, live Railway/Vercel service
IDs, the interview-day checklist) that has no equivalent in `docs/DEPLOYMENT.md`.
Cross-linked both files so there is exactly one file named `DEPLOYMENT.md` and
no more two-files-two-truth ambiguity. Nothing else in the repo referenced the
old root filename (checked). Changes are unstaged in the working tree, not
committed.

**Council deliberation — fallback selection logic traced, live-tested, and two
bugs fixed.** Could not boot the actual Fastify API server locally to test
`POST /council/deliberate` at the HTTP route level: every `@nexus/*` package
under this checkout's `node_modules` (confirmed for `@nexus/llm-drivers`,
`@nexus/council`, `@nexus/db`, and others) is an empty real directory, not a
symlink or junction to the workspace package — `tsx`/`esbuild` resolve
`@nexus/*` imports to nothing and `pnpm --filter @nexus/api dev` fails
immediately. This predates this task and is not something the code changes
here touch. `pnpm install` would fix it but wants to reinstall all 151
workspace packages from scratch and needs an interactive confirmation this
non-interactive shell cannot give. Recommend running the dev server from WSL
instead (matches `REDEPLOY_RUNBOOK.md`'s own `cd /home/yash/Nexus`
instruction), or running a full `pnpm install` on Windows first.

Given that blocker, verified the code path a different way for each half:

*No-key fallback to local Ollama.* Read `buildCouncilServiceForUser` in
`apps/api/src/routes/council.ts` line by line: when the active council
provider has no BYOK key on file for the requesting user and the server is
in local mode (`NEXUS_LLM_PROVIDER=ollama`, set in this environment's
`.env`), it registers a local `OllamaDriver` and switches the effective
model alias to `nexus/local` instead of returning the 400 it would return in
cloud mode. Also confirmed the fallback's terminal dependency directly: sent
a real chat request to the local Ollama server at `OLLAMA_BASE_URL` with
`NEXUS_DEFAULT_MODEL` (`qwen2.5:7b`) and got a real completion back (HTTP
200, content "ok").

*Keyed-provider path (Groq, Gemini, Mistral, OpenRouter).*
`buildUserDriverRegistry` (`apps/api/src/lib/provider-keys.ts`) is strict
BYOK — it resolves each provider's key from the user's encrypted row in
`user_provider_credentials`, with no `.env` fallback for any of these four.
Verified the four drivers' actual HTTP mechanics by sending the exact
request each driver sends to the real vendor API, using the keys already in
`.env`:

- Groq (`llama-3.3-70b-versatile`): HTTP 200, real completion.
- Mistral (`mistral-large-latest`): HTTP 200, real completion.
- Gemini: the council alias's hardcoded model, `gemini-1.5-pro`, returned
  HTTP 404 (retired). Found a working replacement, `gemini-flash-latest`
  (HTTP 200, real completion), and applied it.
- OpenRouter: the driver's hardcoded default model,
  `anthropic/claude-3.5-sonnet`, returned HTTP 404 (retired from
  OpenRouter's catalog). Found a working replacement,
  `anthropic/claude-sonnet-5` (HTTP 200, real completion), and applied it.

Two code-level bugs were found in the fallback/selection logic itself, both
fixed in this change, in both `apps/api/src/routes/council.ts` and its
worker-side duplicate `apps/worker/src/handlers/council-handler.ts`:

1. `COUNCIL_DRIVER_ALIASES` had no entry routing to OpenRouter at all,
   despite `REDEPLOY_RUNBOOK.md` documenting Groq/Gemini/Mistral/OpenRouter
   as the four keyed council providers — there was no way to select
   OpenRouter for a council deliberation. Added a `nexus/openrouter` alias,
   and registered `OpenRouterDriver` in the worker handler's key-loading
   function (the API route's BYOK loader already supported the provider
   generically).
2. Both files resolved an unrecognized `COUNCIL_MODEL` value by silently
   defaulting to Groq, in two separate places in each file. A typo'd or
   stale `COUNCIL_MODEL` — including, before fix 1, any attempt to select
   OpenRouter — would silently reroute every deliberation to Groq instead of
   erroring. Replaced this with a startup-time check that fails loudly if
   `COUNCIL_MODEL` is not a known alias, plus a matching check at the point
   of use.

Also found while reading `GeminiDriver` for the stale-model-id fix: its
`complete()` and `stream()` carried a routing condition and comment copied
from `OllamaDriver` (`opts.model && !opts.model.includes("/") ? opts.model :
this.model`) that does not make sense for a cloud driver — it silently
discarded any caller-supplied model id containing a `/` and used its own
default instead. The identical code, from the same source commit, was also
copied into `ReplicateDriver` and `BaiduErnieDriver`; for Replicate
specifically this was a live bug, since Replicate's own model-id convention
(`owner/model`) always contains a `/`, so an explicitly requested Replicate
model was never actually honored. Fixed all three call sites, reverting to
the plain `opts.model ?? this.model` already used by the OpenAI-compatible
drivers (Groq, Mistral, OpenRouter, DeepSeek). This bug did not affect the
council path itself, since council always passes an explicit slash-free
model id, but it is a real bug in shared driver code worth having fixed
while already in that function.

Not fixed, flagged for follow-up: the same stale `gemini-1.5-pro` and
`anthropic/claude-3.5-sonnet` ids also appear, independently hardcoded, in
`apps/api/src/routes/gateway.ts`'s own alias table and in several other
packages (`provider-registry`, `telemetry`, `ultraplinian`, `consortium`,
`gauntlet`, `api-bridge.ts`). None of those are on the council deliberation
path; a repo-wide sweep is separate work.

Verification method note: a standalone `node --experimental-transform-types`
script that imports `packages/llm-drivers/src/index.ts` directly (it has no
internal `@nexus/*` imports, so it is unaffected by the broken workspace
linking) exercises the driver-level fixes against a `MockTransport` and
asserts on the outgoing request; it passes after the fix. `council.ts` and
`council-handler.ts` could not be exercised the same way — they import
`@nexus/db`, `@nexus/contracts`, and `@nexus/tier-gate`, all empty
directories in this checkout — so that logic was verified by close reading;
`council-handler.ts` mirrors `council.ts` closely enough that the same fixes
and the same reasoning apply to both.

Bottom line: with the two selection-logic bugs above fixed, the council
deliberation path now has a working code route to all four documented keyed
providers (Groq, Gemini, Mistral, OpenRouter) plus the keyless Ollama
fallback. What remains unverified in this environment specifically is the
actual HTTP round trip through a booted `apps/api` server — blocked by the
pre-existing broken `node_modules` linking described above, not by anything
this change touched.

**Hard call 2 — branch fold, recommendation only, nothing deleted:**

- Keep `main`. It is the trunk; once `fresh` is pushed and merged into it,
  nothing else needs to happen to it.
- Delete `ollama` — but only after `fresh` is on `origin` and merged into
  `main`. Confirmed zero unique commits: `fresh` already carries everything
  on `ollama`, and `ollama` has no upstream tracking branch of its own.
- Delete `local-dirty` — same timing condition. Confirmed it is `ollama` plus
  one commit (`d78e459`) that is a filemode-only, zero-insertion,
  zero-deletion change (an exec-bit flip from a Windows checkout of the husky
  hooks and the chaos/codegen scripts). No unique content.
- Order matters: push `fresh` (needs the PAT `workflow` scope bump) → merge or
  fast-forward `main` onto it → confirm `main` has everything → only then
  drop `ollama` and `local-dirty`. Deleting either branch before `fresh` is
  safely on `origin` would put `local-dirty`'s one commit and `ollama`'s tip
  out of reach of anything but the reflog.
