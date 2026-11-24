# Nexus: master plan

One file, one order, from here to a project whose docs and code agree. Every item is small enough
to finish in one sitting and carries the check that proves it. Tick an item only in the commit that
produces its evidence, and put the evidence on the line. If a claim is not in the tree, it does not
go in this file or in any other doc.

**Legend**

- `[x]` done and verified; the line names the proof.
- `[ ]` open.
- **(you)** needs a human: an account, a secret, a certificate, an install, or an approval.
- **(gate)** blocks the next phase; run it, do not reason about it.

**Baseline, 2026-11-23, `0698367`** (`master` level with `origin/master`)

Seven workflows ran on that commit and all are green: Lint, Test, Build & Typecheck, Docker Build &
Push, Security, Release, DB Migrate. The `pre-migration` tag still restores the old tree with
`git reset --hard pre-migration`; it is not a fast-forward base. This file is the only scheduled
plan; superseded records live in git history.

**Definition of done for the whole plan**

1. Offline acceptance passes with no WAN, no cloud database and no cloud model.
2. Online acceptance passes on the deployed host: sign-in, chat, skill, billing row, audit export,
   a second user who cannot read the first user's data, and a revoked session that is refused.
3. Desktop installs from a signed installer, runs its own API, and updates with a rollback.
4. Every language in `NEXUS_SANDBOX_IMAGE` is selectable in the app, or is removed from the image.
5. LSP tools answer definition, references, hover, document symbols and diagnostics in at least
   TypeScript and Python, behind workspace containment and the exec policy.
6. `pnpm check:docs` proves every `process.env` read is documented and every documented variable is
   read; the docs-claims audit has no unchecked row.
7. `pnpm audit --prod --audit-level high` exits 0 and the Dependabot queue is empty or every open
   alert carries a written dismissal.
8. All seven workflows are green on the release commit.

**Deployment values**

- Host: `nexus-iosc.onrender.com`. Render service `srv-davasjdg1s2s739ptc8g` (`nexus-iosc`).
- GitHub OAuth app: homepage `https://nexus-iosc.onrender.com`, callback
  `https://nexus-iosc.onrender.com/api/v1/oauth/github/callback`, client ID
  `Ov23lirM3z6UH32R8zhf`. The secret belongs in Render only.
- Render: `OAUTH_REDIRECT_BASE=https://nexus-iosc.onrender.com` (no trailing slash),
  `ALLOWED_ORIGINS=https://nexus-iosc.onrender.com`.
- Neon `nexus` (`mute-scene-02756044`, us-east-1, PG 17, pgvector 0.8.0). The pooled URL is on
  Render; `DB Migrate` reads the `production` environment secret `DATABASE_URL`, which should be
  the direct URL, because PgBouncer transaction mode breaks DDL and advisory locks.
- Secrets live in dashboards and gitignored local files: GitHub client secret, `DATABASE_URL`,
  `NEXUS_SECRETS_KEY`, `NEXUS_AUDIT_KEY`, `RESEND_API_KEY`. Never in the repo.

---

## Phase 0: gates that stay green

Run this before every commit that claims a phase is done. It is the whole quality bar in one line.

- [x] **(gate)** `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm
      format:check && pnpm check:headers && pnpm types:check && pnpm --filter @nexus/api
      openapi:check && pnpm prune:knip` exits 0.
      Measured 2026-11-23 on this tree: every step exit 0; headers 1,484 files; format 1,517 files;
      gate run on `1c307db`.
- [x] **(gate)** `pnpm test` passes on the change.
      Measured 2026-11-23: `turbo run test` 55 of 55 tasks passed, 0 cached; `@nexus/api` 1,298
      passed, 4 skipped (230 files); `@nexus/agent-core` 1,028 passed.
- [x] **Record the measured baseline** so later work has a comparison.
      Table below, taken on this tree.
- [ ] **(gate)** The seven workflows are green on the pushed commit before the next phase starts.
      Proof: `gh run list --commit <sha>` shows seven `success` rows.

### Measured on this tree

| Check                                    | Result                              |
| ---------------------------------------- | ----------------------------------- |
| `pnpm install --frozen-lockfile`         | exit 0, lockfile in sync            |
| `pnpm test`                              | 55/55 turbo tasks; api 1,298 passed |
| `pnpm typecheck`                         | exit 0                              |
| `pnpm types:check`                       | in sync                             |
| `pnpm --filter @nexus/api openapi:check` | in sync (410 paths, 513 operations) |
| `pnpm prune:knip`                        | exit 0, no findings                 |
| `pnpm audit --prod --audit-level high`   | exit 0, 3 advisories, none high     |
| `pnpm audit --audit-level high`          | exit 0, 3 advisories, none high     |
| UI e2e                                   | 47 passed, 11 skipped               |
| Desktop e2e                              | 1 passed                            |
| `docker compose config`                  | exit 0                              |
| `pnpm check:offline`                     | 2 passed, 4 skipped, 0 failed       |

Dependency entries went from 283 at `pre-migration` to 289 at `HEAD` (+6): `vite-plus` in each
workspace that runs `vitest`, with root `vitest`, `oxlint`, `oxlint-tsgolint` and `prettier`
removed. 289 is the gate.

---

## Phase 1: unblock the operator items

Everything here is yours. Nothing else in the plan can finish without it.

- [ ] **(you) Fix the GitHub OAuth app's own fields.** Homepage
      `https://nexus-iosc.onrender.com`; authorization callback
      `https://nexus-iosc.onrender.com/api/v1/oauth/github/callback`. The client ID is
      `Ov23lirM3z6UH32R8zhf`; the secret stays in Render.
      Proof: `/api/v1/oauth/providers` still returns `{"google":false,"github":true}` and a browser
      sign-in on the host completes and survives a reload.
- [ ] **(you) Rotate the GitHub client secret.** It appeared in a chat transcript; treat it as
      public. Create a new secret, update Render, deploy.
      Proof: a fresh sign-in works and the old secret is deleted at GitHub.
- [ ] **(you) Google sign-in, when a tenant exists.** Google Cloud project, OAuth client, consent
      screen review; set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on Render.
      Proof: `/api/v1/oauth/providers` returns `{"google":true,"github":true}` and the Google button
      completes a sign-in.
- [ ] **(you) Add a cloud model key for online acceptance.** The deployed host cannot reach this
      machine's Ollama. Use a provider key in Render (`GROQ_API_KEY` or another registered
      provider).
      Proof: one chat turn on the host returns model content, not a configuration error.
- [ ] **(you) Install the local tools that are still missing.** Present: `k6`, `ollama`. Missing:
      `gitleaks`, `trivy`, `syft`, `psql`. Commands are in Appendix B.
      Proof: `gitleaks version`, `trivy --version`, `syft version`, `psql --version` all answer.
- [ ] **(you) Repoint `OLLAMA_MODELS`.** It points at `D:\brain-models\ollama`, which does not
      exist. Unset it or point it at `%USERPROFILE%\.ollama\models`.
      Proof: `ollama serve` starts and `ollama list` shows `qwen2.5:7b`.
- [ ] **(you) Desktop signing material.** A Windows code-signing certificate (OV or EV) and an
      Apple Developer ID Application certificate plus notarisation credentials, stored as CI
      secrets only.
      Proof: `signtool verify` passes on the NSIS installer and `spctl --assess` passes on the dmg.
- [ ] **(you) Update-feed host.** A domain or bucket for the signed update feed and its credentials.
      Proof: the feed URL answers with a signed manifest from CI.

---

## Phase 2: online, end to end

Target: a stranger signs up on `https://nexus-iosc.onrender.com` and does real work, and a second
stranger cannot see the first one's work.

- [x] **Deploy and migrate are healthy.** `/health/ready` returns 200 with `db` and `kv` ok on
      `nexus-iosc.onrender.com`; `DB Migrate` is green against Neon `mute-scene-02756044`. The
      pooled URL is on Render; the `production` secret should be the direct URL, because PgBouncer
      transaction mode breaks DDL and advisory locks.
- [ ] **Live sign-in.** Needs Phase 1's OAuth URLs.
      Proof: browser sign-in, reload, still signed in.
- [ ] **Sign-up and session.** Create an account on the host and confirm the session survives a
      reload.
      Proof: 201/200 responses and one screenshot-free assertion (the authenticated `/api/v1/me` or
      equivalent returns the new user).
- [ ] **One chat turn.** Send a prompt and read model content back.
      Proof: the response id and the content prefix.
- [ ] **One skill run.** Run a skill that needs no extra credential.
      Proof: the run id and its terminal status.
- [ ] **Billing row is free plus BYOK.** No subscription exists by design.
      Proof: the row shows the free allowance and a BYOK path, and no paywall blocks the journey.
- [ ] **Audit export.** Download it and find the events above in it.
      Proof: the downloaded file and the matching event ids.
- [ ] **Second user is isolated.** User B cannot open user A's session, drive, or sandbox run by id.
      Proof: B gets 404/403 for each of A's identifiers.
- [ ] **Revoked session is refused.** Sign out or revoke, then replay the old bearer token.
      Proof: 401, and the UI returns to signed-out.
- [ ] **`pnpm check:online` exists and is honest.** A script that reads `NEXUS_ONLINE_BASE_URL` and
      an operator-supplied `NEXUS_ONLINE_API_KEY`, checks `/health/ready`,
      `/api/v1/oauth/providers`, the OpenAPI document, and the UI, and reports `skip` with a reason
      when either variable is unset. Attempted failures exit 1.
      Proof: one run with values, one without; output matches both.
- [ ] **CORS and CSP on the deployed origin.** Only `ALLOWED_ORIGINS` is accepted; a preflight from
      another origin gets no allow-origin header; CSP reports land in the log and do not break the
      app.
      Proof: one refused preflight; the browser console is clean.
- [ ] **Rate limiting behaves.** One key shares `NEXUS_API_RATE_LIMIT`; a burst returns 429 and the
      UI says "throttled", not "failed".
      Proof: a burst test and one UI message.

---

## Phase 3: offline, end to end

Target: no WAN, no cloud database, no cloud model, real work.

- [x] **Offline boot.** `DATABASE_URL` unset resolves to `pglite://.nexus/db`; `/health/ready`
      returns `{db: ok, kv: ok, costlog_flush: ok}` with outbound sockets blocked.
- [x] **Offline model.** `qwen2.5:7b` (4.36 GB) answered `OK` (9 tokens) through
      `POST /v1/chat/completions` with `model: "ollama/qwen2.5:7b"`, and the streaming form
      delivered `chat.completion.chunk` events to the end.
- [x] **Sandbox image.** `infra/sandbox/Dockerfile`: Node 26, Python, Go, Rust, Ruby, Bash and tsx
      on uid 1000, base pinned by digest, writable paths on a scratch tmpfs with `mode=1777`.
      Verified under `--network=none` and `--read-only`.
- [x] **Compose wiring.** The sandbox service builds the image; the api gets
      `NEXUS_SANDBOX_IMAGE`, the `docker.sock` mount and `WITH_DOCKER_CLI`. TypeScript travels on
      stdin; unsetting the image fails closed.
- [x] **Search wiring.** SearXNG answers `/healthz`; the api reaches `http://searxng:8080` through
      `SEARXNG_URL`. `SEARXNG_BASE_URL` only configures the container.
- [x] **Offline desktop.** The packaged app boots its own API on a loopback port against PGlite,
      serves the built UI, and registration, restart and login all survive.
- [x] **Offline acceptance script.** `scripts/offline-check.mjs` (`pnpm check:offline`): 5 passed,
      0 skipped, 0 failed, covering boot, a real model turn, the sandbox image, SearXNG and the
      desktop/UI builds. Missing prerequisites are `skip` with a reason; attempted failures exit 1.
- [x] **Document the search surface once.** `docs/TESTING.md` already says SearXNG needs upstream
      engines; add the matching sentence to `docs/STATUS.md` (search/provider row): offline SearXNG
      proves reachability, not answers, and `@web` in the composer resolves to a URL that is
      fetched, not a query that is answered.
      Proof: both files say it and match the `type === "web"` branch in `mentionContext`.
- [x] **Offline LSP.** `scripts/offline-lsp-probe.mjs` drives the pool when a server exists and
      skips with the reason otherwise. `pnpm check:offline` reports
      `[skip] offline lsp: no binary: typescript-language-server is not on PATH` on this machine
      (2 passed, 4 skipped, 0 failed); the definition path runs on a machine with the binary.

---

## Phase 4: desktop M4, installable and updatable

- [x] **Bundle the API.** `scripts/build-desktop-api.mjs` (`pnpm build:desktop-api`) bundles the
      API and every `@nexus/*` package to ESM, stages a hoisted production deploy, copies
      migrations and the UI build, and `main.ts` prefers that tree. Booted on plain `node` with no
      checkout: `/health/ready` 200, UI 200, register 201, 24 migrations applied.
      Size: 908 MB of dependencies (onnxruntime dominates) plus 6.3 MB of UI.
- [ ] **Measure the installer before building the feed.** Record installer size, install time and
      cold start on a clean Windows VM and on macOS.
      Proof: three numbers in `docs/STATUS.md`; if the installer exceeds 1.5 GB, decide whether
      onnxruntime is optional and record the decision.
- [ ] **Windows installer.** electron-builder NSIS target, per-user install, no admin prompt,
      uninstall keeps the data directory unless the user opts out.
      Proof: install, launch, register, close, relaunch, log in; uninstall and reinstall keeps the
      data.
- [ ] **macOS dmg.** arm64 and x64, hardened runtime, notarised and stapled.
      Proof: `spctl --assess --type execute` passes; the app opens without a Gatekeeper override.
- [ ] **Sign in CI.** Both installers are signed in the release workflow from the Phase 1 secrets,
      never from a developer machine.
      Proof: the workflow log shows signing and notarisation; the artifacts verify.
- [ ] **Auto-update manifest.** CI writes a signed manifest (version, platform, URL, sha256) to the
      feed from Phase 1.
      Proof: the feed URL returns the manifest and its signature verifies with the embedded key.
- [ ] **Version check on launch.** One request, a short timeout, and no launch delay when the feed
      is unreachable.
      Proof: launch time with and without the feed.
- [ ] **Download and verify.** Fetch in the background, verify the signature and sha256, and refuse
      a mismatch.
      Proof: one good artifact installs; one tampered byte is refused.
- [ ] **Install on quit and roll back.** Apply on quit; if the new build does not reach
      `/health/ready`, restore the previous build and start it.
      Proof: ship `N`, then `N+1`; a deliberate bad `N+1` leaves `N` running after one restart.
- [ ] **Desktop LSP is on by default.** The embedded API sets `NEXUS_LSP=1` and resolves server
      commands from `PATH`; with no server installed the tools are absent, not broken.
      Proof: definition works in the packaged app against a local TS file with no network.
- [ ] **Release artifacts.** NSIS installer, dmg, `SHA256SUMS`, SBOM and the update manifest are
      attached to the GitHub release.
      Proof: every file downloads and its checksum matches.

---

## Phase 5: make the sandbox honest about languages

The image runs Go 1.19.8, rustc 1.63.0 and Ruby 3.1.2, and each answers under
`--network=none --read-only -u 1000`, but the app types `SandboxLanguage` as
`javascript | typescript | python | bash` and refuses the rest. Either expose them or remove them
from the image; exposing them is the smaller change.

- [x] **Widen the type.** `SANDBOX_LANGUAGES` is the only list; `SandboxLanguage` is derived from it and
      `prepareExecution` routes Go, Rust and Ruby through a stdin-written scratch file, like
      TypeScript (2026-11-23).
      Proof: `pnpm --filter @nexus/sandbox test` -> 99 passed, 1 skipped, and a test asserts the
      seven names.
- [x] **Widen the helper.** `apps/sandbox-helper/src/server.ts` builds `LANGUAGES` from
      `SANDBOX_LANGUAGES`; the image allowlist is unchanged (2026-11-23).
      Proof: `pnpm --filter @nexus/sandbox-helper test` -> 18 passed; a real `POST /run` against
      `nexus-sandbox:local` returned 200, exit 0 and `go-ok`, `rust-ok`, `ruby-ok`.
- [x] **Widen the API and the UI.** `routes/sandbox.ts` advertises the shared list in
      `/sandbox/status`; the page's snippets cover the same seven (2026-11-23).
      Proof: the status test expects `[...SANDBOX_LANGUAGES]` and `apps/ui` snippet test passes (3
      tests); no second hard-coded list.
- [x] **Fix the `docs/STATUS.md` sandbox row.** It now names the seven image languages, the Piston-only
      `r`, and which path answered (2026-11-23).
      Proof: the row matches `/sandbox/status`'s `languages` array.
- [x] **Keep Piston optional.** A self-hosted Piston behind `PISTON_URL` is still the only way to
      run a language the image lacks; the status endpoint says which path answered (2026-11-23).
      Proof: with `PISTON_URL` unset the API test asserts the image list only, and Go/Rust/Ruby fail
      closed with the `PISTON_URL` hint instead of running on the host.
- [x] **Make the scratch mount executable.** Some hosts mount tmpfs `noexec` by default, which broke
      `go run` and every `rustc` output (`permission denied`); the mount now says `exec` explicitly,
      keeping `nosuid,nodev` (2026-11-23).
      Proof: `buildDockerArgs` test pins the option; a real Docker run of all three languages
      returned exit 0.

---

## Phase 6: LSP-backed code intelligence

Agents currently read and grep. They cannot ask where a symbol is defined, who references it, or
what the type checker thinks. This phase adds a client, not a language server: the server is an
operator-installed binary, and Nexus speaks LSP to it over stdio.

**Shape**

- `packages/lsp`, no runtime dependency beyond Node: framing, transport, client, pool, documents.
  The agent tools live in `packages/agent-core/src/runtime/lsp-tools.ts`; spawn authorization is a
  callback the API supplies, so the package never imports the API or the policy.
- One server process per `(workspace root, language)`, pooled, idle-evicted, memory-capped.
- Read-only tools are `auto_allowed`; rename and code actions are `requires_permission`.
- Workspace root comes from the tool context, then `NEXUS_LSP_ROOTS`, then `NEXUS_EXEC_ROOTS`,
  then `NEXUS_WORKSPACE_DIR`. A path outside it is refused, symlinks included.
- Each call is a `tool.call` span, so latency and failures land in traces.
- Off by default on a shared host. The desktop's embedded API turns it on.

### 6.1 Package scaffold

- [x] **Create `packages/lsp`.** `package.json` (`@nexus/lsp`, private, `type: module`, exports
      `./src/index.ts`), a `tsconfig.json` extending the base, `src/` and colocated `*.test.ts`
      (2026-11-23).
      Proof: `pnpm typecheck` and `pnpm prune:knip` exit 0; the package is not yet an API
      dependency because no API route imports it.
- [x] **Write the file map down** at the top of `src/index.ts`: `framing.ts` (Content-Length),
      `transport.ts` (spawn and JSON-RPC), `client.ts` (handshake and requests), `manager.ts`
      (pool), `languages.ts` (extensions, commands, env), `documents.ts` (sync); plus `config.ts`,
      `containment.ts` and `testing/fake-server.mjs` (2026-11-23). The tools are not here; they live
      in agent-core.
      Proof: each file exists and exports what the map says.

### 6.2 Transport and framing

- [x] **Encode and decode `Content-Length` frames.** Case-insensitive header, `\r\n\r\n` separator,
      partial reads across chunks, a header cap (8 KB), a body cap (8 MB), and a close on a bad
      frame instead of a hang (2026-11-23).
      Proof: `framing.test.ts` feeds byte-at-a-time, two frames in one chunk, a missing length, a
      header over the cap and a body over the cap.
- [x] **Speak JSON-RPC with ids.** Monotonic request ids, response routing, notifications dropped
      or forwarded by name, a request timeout that rejects once and clears the pending entry, and
      no unhandled rejection when the process dies mid-request (2026-11-23).
      Proof: `transport.test.ts` covers out-of-order responses, a timeout and a kill mid-request.
- [x] **Model it on the existing stdio client.** `transport.ts` names
      `packages/mcp-client/src/stdio.ts` and states why LSP differs (mandated `Content-Length`
      framing) (2026-11-23).
      Proof: the header comment exists.

### 6.3 Process lifecycle

- [x] **Spawn without a shell.** `spawn(command, argv, { shell: false, cwd, env })` in
      `transport.ts`; the command and argv come only from `NEXUS_LSP_*_CMD`, split by
      `splitCommand` with double quotes honoured (2026-11-23).
      Proof: `config.test.ts` keeps a quoted path with spaces as one argv and does not interpret
      `;` or `&&`; `transport.test.ts` passes both forms through to the process as single argv
      entries.
- [x] **Handshake.** `initialize` carries `processId`, `rootUri`, capabilities and full document
      sync, then `initialized`; server capabilities and `serverInfo` are stored, and a miss of
      `NEXUS_LSP_START_TIMEOUT_MS` kills the child (2026-11-23).
      Proof: `client.test.ts` asserts the two messages, the stored capabilities and the timeout.
- [x] **Shut down cleanly.** `shutdown`, then `exit`, then `killTree` after 2 s; on Windows the tree
      kill is `taskkill /pid <pid> /T /F` (2026-11-23).
      Proof: `client.test.ts` sees a server that ignores `shutdown` gone after the grace period.
- [x] **Minimal environment.** The child gets only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`
      via `minimalChildEnv` (2026-11-23).
      Proof: `client.test.ts` asserts `NEXUS_API_KEY` is absent from the child env.
- [x] **Honour `NEXUS_LSP_LOG` for captured stderr.** `client.ts` forwards the ring tail to
      `process.stderr` only when the parsed level is `info` or `debug`; `off` keeps it in the ring
      only. `packages/lsp/src/client.test.ts` asserts no `[lsp]` line at `off` (while the ring still
      holds the text) and a forwarded line at `info`.

### 6.4 Pool and resource caps

- [x] **Key the pool by `(root, language)`.** One server per pair, LRU at `NEXUS_LSP_MAX_SERVERS`
      (default 2); a third stops the oldest idle one (2026-11-23).
      Proof: `manager.test.ts` counts starts and sees the third language after one stop.
- [x] **Idle eviction and shutdown.** A server stops after `NEXUS_LSP_IDLE_MS` (default 300000)
      with no request; `dispose()` stops every entry and calls `onClose` (2026-11-23).
      Proof: a clock-injected idle test and a `dispose` test that asserts zero servers and one
      callback.
- [x] **Memory watchdog.** RSS is sampled every 15 s; above `NEXUS_LSP_MAX_MEMORY_MB` (default 1024) the server stops, is marked unhealthy for 60 s, and the next call starts a fresh one
      (2026-11-23).
      Proof: a test with a fabricated RSS reading.
- [x] **Crash policy.** A server that exits unexpectedly restarts once; a second crash inside 60 s
      marks it broken and the call returns a reason instead of spawning forever (2026-11-23).
      Proof: a fake server that exits on the second `initialize`.

### 6.5 Workspace containment

- [x] **Resolve the root once.** First `ctx.workingDir`; then the first entry of `NEXUS_LSP_ROOTS`;
      then `NEXUS_EXEC_ROOTS`; then `NEXUS_WORKSPACE_DIR`. No root means the tools are absent
      (2026-11-23).
      Proof: `containment.test.ts` covers each fallback and "none".
- [x] **Refuse escapes.** Canonicalises with `realpath`, rejects a path outside the root, a symlink
      that resolves outside, a non-file, and a file above `NEXUS_LSP_MAX_FILE_BYTES` (default
      1,000,000) (2026-11-23).
      Proof: `containment.test.ts` covers `..`, an absolute path, a symlink to another root, a
      directory and an oversized file.
- [x] **Map extensions to languages.** `.ts/.tsx/.js/.jsx/.mjs/.cjs` to TypeScript, `.py/.pyi` to
      Python, `.go` to Go, `.rs` to Rust; anything else is "no server", never a guess (2026-11-23).
      Proof: a table-driven `languages.test.ts` plus the unknown-extension cases.

### 6.6 Document sync

- [x] **Open, change, close.** `didOpen` sends full text and version 1; `didChange` sends full text at
      `version + 1` (never incremental deltas); `didClose` on eviction; open documents are capped at
      `NEXUS_LSP_MAX_DOCUMENTS` (default 50), evicting the least recently used (2026-11-23).
      Proof: `documents.test.ts` records versions 1, 2, 3, the close and the LRU eviction.
- [x] **Wait for diagnostics correctly.** After `didOpen`/`didChange`, waits up to
      `NEXUS_LSP_DIAGNOSTICS_WAIT_MS` (default 3000) for `publishDiagnostics` for that URI and
      version; on timeout returns the last known set with `stale: true` (2026-11-23).
      Proof: early, late and missing publishes in `documents.test.ts`.
- [x] **Cache per document.** The last diagnostics and symbol list are keyed by URI + version, so a
      repeat read is cheap and a version bump invalidates the entry (2026-11-23).
      Proof: two symbol reads produce one server request; the manager test asserts it.

### 6.7 Read-only tools

- [x] **Define five tools** in `packages/agent-core/src/runtime/lsp-tools.ts`, built on the
      `@nexus/lsp` client and the existing `RuntimeTool` shape:
      `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_diagnostics`.
      Input is `{ path, line, column }` with 1-based line and column at the boundary, converted to
      0-based LSP positions; output is normalised arrays with `path`, `line`, `column` and a
      one-line `preview`.
      Proof: schema snapshot test and one fake-server call per tool.
- [x] **Cap every result.** At most 200 locations, 20 references per symbol, hover text at 8 KB,
      diagnostics at 200; truncation is reported as `truncated: true`, not silently dropped.
      Proof: tests at the boundary and one over it.
- [x] **Auto-allow them.** Add the five names to `AUTO_ALLOWED_TOOLS` in
      `packages/agent-core/src/runtime/index.ts` and to the filesystem tools' doc comment that
      lists read-only tools.
      Proof: `classifyTool` returns `auto_allowed` for each.

### 6.8 Gated tools

- [x] **`lsp_rename` returns an edit, never applies one.** It takes the new name, returns the
      `WorkspaceEdit` mapped to readable `{path, range, newText}`, and the model applies it through
      `edit_file`; no file is written by the LSP client.
      Proof: test asserts zero writes and a well-formed edit.
- [x] **`lsp_code_actions` lists, never applies.** It accepts a range and returns titles, kinds and
      a `command` payload that is not executed.
      Proof: fake server returns one action; no edit reaches the filesystem.
- [x] **Both are `requires_permission` by default.** They are absent from `AUTO_ALLOWED_TOOLS`, so
      `classifyTool` returns `requires_permission`; the existing approval flow applies unchanged.
      Proof: classification test and one 202 in an API test.

### 6.9 Exec policy integration

- [x] **Add the `lsp` surface.** `ExecSurface` includes `"lsp"` with the default `allow`, and the
      reason is written down: the binary and argv are operator configuration, not model input;
      `readonly` still denies everything; deny rules still apply (2026-11-23).
      Proof: `packages/exec-policy` tests cover `readonly`, `NEXUS_EXEC_ASK_SURFACES=lsp` and a
      deny rule on the server binary.
- [x] **Gate every spawn through an injected callback.** The manager takes
      `authorize(action: {command, args, cwd}) => Promise<"allow" | "ask" | "deny">`; the API
      supplies one that calls `decide()` and, on `ask`, creates the record in
      `apps/api/src/lib/exec-approvals.ts` and returns the approval id. On `deny` the tool error
      names the rule; on `ask` the caller gets 202 with the id.
      Proof: an API test that approves once, runs once, and cannot replay the approval.
- [x] **Constrain `cwd`.** When `NEXUS_EXEC_ROOTS` is non-empty, a root outside it is refused even
      if `NEXUS_LSP_ROOTS` names it (2026-11-23).
      Proof: `containment.test.ts` and `manager.test.ts` refuse before authorizing a spawn.

### 6.10 Telemetry

- [x] **Extend `withToolSpan` with optional attributes.** The two-argument call sites are unchanged;
      `withToolSpan(name, tier, fn, attrs?)` merges `attrs` under `tool.name` and `tool.tier`
      (2026-11-23).
      Proof: `packages/telemetry` tests pass (107) and `tool-spans.test.ts` asserts the extra
      attributes.
- [x] **Wrap every LSP tool call.** Use the same wrapper as `read_file` and `write_file`, so one
      turn with a definition and a diagnostics call yields three nested spans under `agent.turn`.
      Proof: `tool-spans.test.ts` extension.

### 6.11 Runtime wiring

- [x] **Build the toolset once.** A `createLspTools({ root, manager })` helper in agent-core;
      `missions.ts` includes it when `NEXUS_LSP=1` and a root resolves, and the chat runtime
      includes it in the same condition. Otherwise the tools are absent, not failing.
      Proof: mission toolset test with the flag on and off.
- [x] **Fail with instructions, not silence.** A missing binary makes that language unavailable:
      `"python: set NEXUS_LSP_PYTHON_CMD to a pyright-langserver binary"`. The other languages keep
      working.
      Proof: test with `NEXUS_LSP_PYTHON_CMD` pointing at a missing path.

### 6.12 API surface

- [x] **`GET /api/v1/lsp/status`.** Returns `{enabled, root, servers: [{language, state, pid,
      rssMb, requests}], languages: [{language, available, reason}]}` and never a command line or
      an absolute path outside the root.
      Proof: API test and OpenAPI entry.
- [x] **`POST /api/v1/lsp/servers/:language/restart`.** Admin only; stops and clears one entry.
      Proof: 200 for an admin, 403 for another user.
- [ ] **Back `@symbol` with `workspace/symbol`.** `GET /context/symbols?q=` asks every available
      server for `workspace/symbol` when LSP is enabled, merges the results, maps them to
      `{name, type, file, line, source: "lsp"}`, caps at 50, and falls back to the existing regex
      walk with `source: "regex"` when no server answers. Cache for 30 s, invalidate on a
      successful write.
      Proof: one response of each kind, same shape, and the UI renders both.
- [ ] **Regenerate the spec and types.** `pnpm openapi:generate`, `pnpm types:generate`, and commit
      the generated files with the routes.
      Proof: `pnpm openapi:check` and `pnpm types:check` exit 0.

### 6.13 UI

- [x] **Show the source in the `@symbol` picker.** `ContextPicker` keeps its result shape and adds
      a small `lsp` badge; no new endpoint and no second picker.
      Proof: a component test with one LSP result and one regex result.
- [x] **Show availability where the user looks.** The chat composer hides the symbol kind when
      `/api/v1/lsp/status` says no server is available, and the tooltip names the missing server
      variable.
      Proof: one test for available and one for unavailable.

### 6.14 Environment

- [x] **Add the `NEXUS_LSP_*` block to `.env.example`** exactly as Appendix A.1, with the defaults
      and the security note. Do this in the same change as the code that reads them.
      Proof: `pnpm check:docs` (Phase 8) passes.

### 6.15 Tests

- [x] **Fake server fixture.** `src/testing/fake-server.mjs` answers `initialize`, `definition`,
      `references`, `hover`, `documentSymbol`, `workspace/symbol`, `rename`, `codeAction` and
      `shutdown`, with scripted delays and a forced crash (2026-11-23).
      Proof: the package suite passes on this machine, which has no language server installed.
- [x] **Real-server integration, skipped without the binary.** One test per language that runs
      when the command is on `PATH`, otherwise reports `skip` with the reason. TypeScript first,
      then Python.
      Proof: locally `typescript-language-server` returns a definition for a fixture; CI without it
      reports two skips.
- [x] **Containment tests are hostile.** `..`, absolute paths, a symlink out of the root, a
      metacharacter filename, a 10 MB file and another user's root (2026-11-23).
      Proof: each is a `containment.test.ts` case; a metacharacter name is one path and never
      reaches a shell, and the other five are refusals.
- [x] **No server leak.** After the suite, no child process is left; assert with a process count
      before and after.
      Proof: test helper, not a manual check.

### 6.16 Packaging

- [ ] **Desktop bundle includes `@nexus/lsp`.** It is a workspace package, so the existing rolldown
      bundler picks it up; verify by booting the staged tree and calling `GET /api/v1/lsp/status`.
      Proof: status returns `enabled: true` in the packaged app with `NEXUS_LSP=1`.
- [x] **Hosted stays off.** Neither `docker-compose.yml` nor `render.yaml` sets `NEXUS_LSP`, so the
      parsed default (`0`) applies; `packages/lsp` reads the flag and the status route reports
      `enabled: false`. The desktop app is the only place that sets `NEXUS_LSP=1`
      (`apps/desktop/src/local-api.ts`), and a hosted deployment needs an operator to add a server
      binary and the flag.
- [ ] **Desktop resolves commands from `PATH`.** Packaged app plus a system
      `typescript-language-server` works; with none, the UI says which variable to set.
      Proof: one manual run each way, recorded in `docs/STATUS.md`.

### 6.17 Documentation

- [x] **The proposal lives in this phase.** The old `docs/proposals/lsp.md` was folded into the
      sections above and deleted, so there is no second LSP plan to drift (2026-11-23).
      Proof: `docs/proposals/` no longer exists and this phase carries the decisions.
- [x] **`docs/STATUS.md` gets one row** naming what works, what is off by default, and what happens
      without a server.
      Proof: the row matches `/api/v1/lsp/status` on a default install.
- [x] **`docs/FEATURES.md` gets the entry only when the tools ship.** No entry before Phase 6's exit
      criteria are ticked.
      Proof: the entry names the five read-only tools and the two gated ones.

### 6.18 Exit criteria

- [x] TypeScript: definition, references, hover, document symbols and diagnostics answer on a
      fixture file. Fake-server tests cover all five; `integration.test.ts` runs them against
      `typescript-language-server` whenever the binary exists (skipped here, no server installed).
- [ ] Python: the same five answer when `pyright-langserver` is installed.
- [x] A rename returns an edit and writes nothing until `edit_file` is called. Manager test and the
      real-server rename test read the file back unchanged.
- [x] A code action is listed and never executed. Fake-server test returns one action, zero writes.
- [x] A path outside the root is refused, symlink included. Containment tests cover `..`, absolute,
      symlink out, directory, oversized file and another root.
- [x] `NEXUS_EXEC_MODE=readonly` refuses to spawn; `NEXUS_EXEC_ASK_SURFACES=lsp` asks once and the
      approval cannot be replayed. `exec-policy` tests plus the API approval test (202 then 403 on
      replay).
- [ ] One trace shows `agent.turn` with `tool.call` children carrying `lsp.language`.
- [x] A server that crashes twice is reported broken and does not loop. Manager crash-policy test.
- [x] `pnpm check:offline` includes an LSP probe that returns a definition.
      `scripts/offline-lsp-probe.mjs`, wired into `scripts/offline-check.mjs`.
- [x] No child process survives the API's shutdown. Dispose tests (client, manager, LSP runtime,
      desktop API shutdown) assert no live server entry.

---

## Phase 7: dependency and secret hygiene

- [x] **Triage all 52 open Dependabot alerts.** Counted before: 52 open (17 high, 23 medium, 12 low)
      through `gh api .../dependabot/alerts?state=open`. `pnpm audit --prod --audit-level high` was
      exit 0 (12 low/moderate) and full-tree audit exit 1 (55 advisories, 17 high). After the fixes:
      full-tree audit 3 advisories, exit 0. Dependabot still lists 52 because it re-reads the pushed
      lockfile and nothing was pushed.
- [x] **Fix the big family first.** `undici` overrides in `pnpm-workspace.yaml`: `undici@7`
      7.24.8/7.30.0 → 7.30.2, `undici@8` 8.11.2 → 8.13.1. Prod audit exits 0 after the install.
- [ ] **Fix the remaining families.** Done for `fast-uri` (3.1.9/4.2.3), `brace-expansion` (2.1.8),
      `ws` (8.23.0), `esbuild` (0.28.2), `fastify` (5.12.8) and `fast-copy` (4.3.3). Three stay open
      because only a breaking major patches them, each pinned by its parent: `glob` 13.0.6
      (`@fastify/static@10`), `minimatch` 10.2.6 (`glob` 13 and `eslint-plugin-import-x`), `katex`
      0.16.47 (`@lobehub/ui@5.18.0`).
- [ ] **Dismiss only with a reason.** Every alert that stays open gets a written dismissal naming
      why it is not reachable; "dev only" alone is not a reason.
      Proof: `gh api repos/…/dependabot/alerts?state=open` returns none, or each has a dismissal.
- [x] **Gate the full tree, not just production.** `pnpm audit --audit-level high` now sits beside
      the prod audit in `.github/workflows/security.yml` and exits 0 on this tree (3 advisories, all
      low/moderate). A green Security run needs the push.
- [ ] **Secret scan stays clean.** `gitleaks detect --no-git -v` and the CI job both report no
      findings after the Phase 1 rotation.
      Proof: both outputs.
- [x] **Document the exec variables.** `NEXUS_EXEC_MODE`, `NEXUS_EXEC_ALLOW`, `NEXUS_EXEC_DENY`,
      `NEXUS_EXEC_ROOTS` and `NEXUS_EXEC_ASK_SURFACES` are read by `@nexus/exec-policy` and absent
      from `.env.example`. Add them with the three-mode explanation and the surface defaults.
      Proof: `pnpm check:docs` passes and the names are findable in `.env.example`.

---

## Phase 8: docs and code agree, permanently

- [x] **Add `scripts/check-env-docs.mjs` and `pnpm check:docs`.** Scan literal `process.env.NAME` in
      `apps/*/src` and `packages/*/src`, and `import.meta.env.NAME` in `apps/ui/app`, subtract a
      short allowlist of framework variables (`NODE_ENV`, `PORT`, `HOST`, `CI`, `PATH`, `HOME`,
      test-only names), and require every remaining name in `.env.example`. Dynamic access such as
      `process.env[key]` is listed for manual review. Report documented-but-unread variables as
      warnings, not failures, because compose, Python and shell read some of them.
      Proof: the script fails on a deliberately removed variable and passes on the tree.
- [x] **Wire the check into CI.** Add `pnpm check:docs` to the Lint job next to `check:headers`.
      Proof: a run that fails when the check fails.
- [x] **Audit the claim-bearing docs.** For each row in `README.md`, `docs/FEATURES.md`,
      `docs/STATUS.md`, `docs/TESTING.md`, `docs/internal/architecture.md` and
      `docs/security/threat-model.md`, name the route, file or test that proves it. Delete or fix
      every claim without a proof.
      Proof: a table in this file's Appendix D with one row per document and its reviewer, or a
      single line per document in the commit message.
- [x] **Delete the superseded planning files.** `docs/stack-migration.md` and
      `docs/proposals/lsp.md` are gone; the facts worth keeping are in this file (2026-11-23).
      Proof: `git ls-files` lists no other plan or migration record.
- [x] **Remove present-tense claims that LSP is unscheduled.** Historical commits stay; current
      docs must not say "nothing implements it" or "deliberately not planned".
      Proof: `rg -n "proposals/lsp|nothing implements|not planned" docs README.md plan.md` hits
      only these history notes.
- [ ] **Keep the measured table current.** Every number in this file and in `docs/STATUS.md` is
      re-measured after Phase 9 and dated.
      Proof: the same command produces the same number.

---

## Phase 9: release

- [ ] **Version and changelog.** Set the next version in the workspace packages that publish and
      write the changelog from the completed phases.
      Proof: `pnpm typecheck` and the release workflow agree on the version.
- [ ] **Tag and publish.** Tag the next semver (desktop is `0.1.0`, so start at `v0.1.0`), let the
      release workflow build the installers, SBOM and checksums, and attach them.
      Proof: the release page lists every artifact; `sha256sum -c SHA256SUMS` passes.
- [ ] **Verify the published artifacts.** Install the Windows build and open the dmg on macOS;
      check the update feed serves the new manifest.
      Proof: two installs and one feed fetch.
- [ ] **(gate) All seven workflows green on the tag commit.** Proof: `gh run list --commit <sha>`.
- [ ] **Close the loop.** Update this file's baseline to the release commit, tick the Definition of
      Done, and leave only the explicitly deferred items with a reason.

---

## Optional: board validations

The Go board in `services/board` is built and tested. These checks need a desktop app, model credits
or cloud storage, so they are not release blockers.

- [ ] **Claude Desktop in-app review.** Point the installed app at `mcp-bridge.exe` and exercise
      `board_inbox`, `board_post` and `board_slice`.
      Proof: one round trip in the app; the stdio bridge itself is already covered by
      `cmd/mcp-bridge/harness_test.go`.
- [ ] **One real OpenCode turn through the board.** Run a task with `opencode` and watch the
      supervisor log.
      Proof: the task reaches `done` and the log matches.
- [ ] **Live R2/B2 snapshot upload.** Set `CLOUDFLARE_R2_*` and `OPEN_BOARD_SNAPSHOT_PASSPHRASE` and
      upload one snapshot.
      Proof: the object exists and decrypts.

---

## Appendix A: environment contract

### A.1 LSP (introduced by Phase 6)

All of these are read by `@nexus/lsp`. Unset means the documented default. The client is off unless
`NEXUS_LSP=1`; the desktop's embedded API sets it, hosted deployments do not.

| Variable                        | Default                              | Meaning                                                                                                                                 |
| ------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_LSP`                     | `0`                                  | Master switch. `0`/unset: no tools, no spawns, status route says disabled. `1`: enable.                                                 |
| `NEXUS_LSP_TYPESCRIPT_CMD`      | `typescript-language-server --stdio` | Command and argv, split on spaces with double quotes honoured, run without a shell. Must speak LSP over stdio.                          |
| `NEXUS_LSP_PYTHON_CMD`          | `pyright-langserver --stdio`         | Same, for `.py` and `.pyi`.                                                                                                             |
| `NEXUS_LSP_GO_CMD`              | `gopls`                              | Same, for `.go`.                                                                                                                        |
| `NEXUS_LSP_RUST_CMD`            | `rust-analyzer`                      | Same, for `.rs`.                                                                                                                        |
| `NEXUS_LSP_ROOTS`               | empty                                | Comma- or semicolon-separated absolute roots this feature may open. Empty falls back to `NEXUS_EXEC_ROOTS`, then `NEXUS_WORKSPACE_DIR`. |
| `NEXUS_LSP_MAX_SERVERS`         | `2`                                  | Live server processes across all roots and languages; LRU eviction above it.                                                            |
| `NEXUS_LSP_IDLE_MS`             | `300000`                             | Stop a server after this long with no request.                                                                                          |
| `NEXUS_LSP_START_TIMEOUT_MS`    | `15000`                              | `initialize` must answer within this or the spawn fails.                                                                                |
| `NEXUS_LSP_REQUEST_TIMEOUT_MS`  | `10000`                              | Any other request must answer within this.                                                                                              |
| `NEXUS_LSP_DIAGNOSTICS_WAIT_MS` | `3000`                               | How long a read waits for `publishDiagnostics` before returning stale.                                                                  |
| `NEXUS_LSP_MAX_MEMORY_MB`       | `1024`                               | Per-server RSS cap; above it the server is stopped and marked unhealthy for 60 s.                                                       |
| `NEXUS_LSP_MAX_DOCUMENTS`       | `50`                                 | Open documents kept in sync; the least recently used is closed above it.                                                                |
| `NEXUS_LSP_MAX_FILE_BYTES`      | `1000000`                            | Largest file that may be opened or synced.                                                                                              |
| `NEXUS_LSP_LOG`                 | `off`                                | `off`, `info` or `debug`. Controls the captured stderr ring buffer. `debug` never includes file text.                                   |

Security rules that are not variables: the command and argv are operator configuration and cannot
be changed by a tool call; the child gets a minimal environment with no Nexus secrets; the child
runs with `cwd` inside an allowed root; the spawn is an `lsp`-surface action under
`NEXUS_EXEC_MODE`, so `readonly` denies it, `ask` can raise it with `NEXUS_EXEC_ASK_SURFACES=lsp`,
and deny rules apply in every mode.

### A.2 Exec policy (exists; documented in Phase 7)

`lsp` joins the surface list in Phase 6; the rest is current.

| Variable                  | Default | Meaning                                                                                                                                                     |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_EXEC_MODE`         | `ask`   | `readonly` denies every action; `ask` runs read-only commands and asks for the rest; `trusted` runs uncovered actions. An unrecognised value becomes `ask`. |
| `NEXUS_EXEC_ALLOW`        | empty   | `name` or `name:arg1 arg2` entries, comma-separated, that are allowed. Each arg must appear among the action's arguments as a whole token.                  |
| `NEXUS_EXEC_DENY`         | empty   | Same shape; deny wins over allow.                                                                                                                           |
| `NEXUS_EXEC_ROOTS`        | empty   | Absolute roots an action's `cwd` may fall in. Empty means unconstrained.                                                                                    |
| `NEXUS_EXEC_ASK_SURFACES` | empty   | Surfaces raised to `ask` despite their default: `pty`, `sandbox`, `repl`, `tool`, `lsp`.                                                                    |

---

## Appendix B: local commands

```
winget install --id GrafanaLabs.k6 -e
winget install --id Gitleaks.Gitleaks -e
winget install --id AquaSecurity.Trivy -e
winget install --id Anchore.Syft -e
winget install --id PostgreSQL.PostgreSQL.18 -e
winget install --id Ollama.Ollama -e
```

`GrafanaLabs.k6` is the CLI; `GrafanaLabs.k6Studio` is a GUI and is not needed.
`PostgreSQL.PostgreSQL.18` installs a server too; uncheck it if you only want `psql`.
Playwright browsers come from `pnpm exec playwright install`. Already present: `gh`, `docker`,
`node`, `pnpm`, `git`, `go`, `python`, `uv`, `k6`, `ollama`.

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm check:offline
pnpm check:online          # after Phase 2 adds it
pnpm check:docs            # after Phase 8 adds it
docker compose up -d --build
docker compose down -v
```

Path notes for this machine: prepend `C:\Users\Yash\AppData\Roaming\npm` for `pnpm` and
`C:\Program Files\Docker\Docker\resources\bin` for Docker. Clear `HTTP_PROXY`/`HTTPS_PROXY` before
`git push` and `gh`, or the CONNECT tunnel fails with 503.

---

## Appendix C: decisions

1. **Sandbox placement.** Compose mounts the socket, the desktop app uses the local Docker CLI, the
   browser app uses the loopback helper. Hosted execution with no install is out of scope.
2. **Desktop installer.** Bundle the API; the offline promise needs it.
3. **Sign-in.** GitHub first, Google when a tenant exists.
4. **Billing.** Free plus BYOK by design. No subscription work.
5. **LSP.** A client, not a server. Read-only tools auto-allowed, rename and code actions gated,
   workspace containment, off on shared hosts.
6. **Sandbox languages.** Expose what the image runs rather than shrink the image.
7. **Push.** Only with explicit approval; one branch, `master`.

---

## Appendix D: proof ledger

Fill one row per claim-bearing document during Phase 8. A row is done when the proof exists and the
claim matches it exactly.

| Document                        | Claims reviewed | Proof used                                                                                                              | Date       | Reviewer    |
| ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| `README.md`                     | 34              | route greps (`local-pty.ts`, `user-data.ts`), package and tool counts, `pnpm test`, `pnpm test:e2e`, workflows          | 2026-11-23 | agent-audit |
| `docs/FEATURES.md`              | 25              | route greps (`kg.ts`, `kb.ts`, `search.ts`, `rlhf.ts`), `openapi.yaml` counts, `pnpm --filter @nexus/api openapi:check` | 2026-11-23 | agent-audit |
| `docs/STATUS.md`                | 40              | route greps, migrations `0019`-`0021`, `pnpm test`, `pnpm test:e2e`, `openapi.yaml` counts                              | 2026-11-23 | agent-audit |
| `docs/TESTING.md`               | 18              | `vitest.config.ts`, `scripts/e2e-server*.mjs`, `.github/workflows/test.yml` jobs                                        | 2026-11-23 | agent-audit |
| `docs/internal/architecture.md` | 24              | `server.ts` scopes, `middleware/auth.ts`, `local-pty-owner.test.ts`, `security-posture.ts`, app manifests               | 2026-11-23 | agent-audit |
| `docs/security/threat-model.md` | 18              | `public-routes.test.ts`, `local-pty-owner.test.ts`, `security-posture.ts`, route greps                                  | 2026-11-23 | agent-audit |
| `plan.md` (this file)           | —               | deferred; the measured table is Phase 9 work                                                                            | 2026-11-23 | agent-audit |
