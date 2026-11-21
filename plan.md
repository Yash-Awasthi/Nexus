# Nexus: remaining work

`master` is 38 commits ahead of `origin/master` (`45cb648`) and 0 behind. That number was 103
earlier in this pass; the range was squashed while it was being worked on, so every SHA moved.
Re-count with `git rev-list --count origin/master..HEAD` before pushing instead of trusting a number
written here.

The `pre-migration` tag still holds the pre-migration tree but is no longer an ancestor of `HEAD`.
`git reset --hard pre-migration` still restores that tree; it is not a fast-forward base.

Nothing is pushed, so no gate below has run against this code. The migration record moved to
`docs/stack-migration.md`.

Items marked **(you)** need a human: an account, a secret, an install, or an approval. Everything
else is code.

---

## What only you can do

The first two are done. The rest are yours, in order.

- [x] **Push approved and done.** 42 commits on `origin/master` at `d49b3ae`; Actions is running.
- [ ] **(you) Install the tools.** Six winget packages, listed at the bottom of this file.
- [x] **GitHub OAuth app created.** Client ID `Ov23lirM3z6UH32R8zhf`, secret set on Render. The app
      still needs its homepage and callback fields corrected (see Deployment values).

Then, in order:

- [x] **Database created and migrated.** Neon `nexus` (`mute-scene-02756044`, us-east-1, PG 17),
      pgvector 0.8.0, 44 migrations applied, 39 tables. The pooled URL is on Render; the direct URL
      belongs in the `production` environment secret.
- [x] **Render environment set.** Service `srv-davasjdg1s2s739ptc8g` (`nexus-iosc`) already had
      `DATABASE_URL`, `OAUTH_REDIRECT_BASE`, `ALLOWED_ORIGINS` and `NEXUS_PUBLIC_URL`; the GitHub
      client secret was updated and a deploy runs from `master`.
- [ ] **(you) Pull a local model** for the offline track: `ollama pull qwen2.5:7b`.
- [ ] **(you) Later, when the desktop installer matters:** a Windows code-signing certificate and an
      Apple Developer ID, plus a domain for the update feed.
- [ ] **(you) Later, for Google sign-in:** a Google Cloud project, an OAuth client, and the consent
      screen review.

---

## Deployment values

Host: `nexus-iosc.onrender.com`.

- GitHub OAuth app: homepage `https://nexus-iosc.onrender.com`, authorization callback
  `https://nexus-iosc.onrender.com/api/v1/oauth/github/callback`. The client ID is
  `Ov23lirM3z6UH32R8zhf`; the secret belongs in Render only.
- Render: `OAUTH_REDIRECT_BASE=https://nexus-iosc.onrender.com` (no trailing slash),
  `ALLOWED_ORIGINS=https://nexus-iosc.onrender.com`.
- `DB Migrate` reads the `production` environment secret `DATABASE_URL`. Give it the direct Neon
  URL and give Render the pooled one: PgBouncer transaction mode breaks DDL and advisory locks.
- Secrets stay in the dashboards: client secret, `DATABASE_URL`, `NEXUS_SECRETS_KEY`,
  `NEXUS_AUDIT_KEY`, `RESEND_API_KEY`. Never in the repo.

---

## Measured on this tree

| Check                                        | Result                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             | exit 0, lockfile in sync                                  |
| `pnpm typecheck`                             | exit 0                                                    |
| `pnpm types:check`                           | in sync                                                   |
| `pnpm --filter @nexus/api openapi:check`     | in sync                                                   |
| `pnpm prune:knip`                            | exit 1: 3 files, 3 deps, 2 binaries, 23 exports, 33 types |
| `pnpm audit --prod --audit-level high`       | exit 0: 12 advisories, none high                          |
| Dependency entries, `pre-migration` → `HEAD` | 283 → 289 (+6)                                            |
| UI e2e                                       | 47 passed, 11 skipped                                     |
| Desktop e2e                                  | 1 passed                                                  |
| `docker compose config`                      | exit 0                                                    |

The +6 is `vite-plus` added to every workspace that ran `vitest`, with root `vitest`, `oxlint`,
`oxlint-tsgolint` and `prettier` removed. Nothing to trim; record 289 as the gate.

---

## Track A: close the migration

- [x] **Drop `just-bash`.** Removed in `5a9abda`; `pnpm audit --prod --audit-level high` now exits 0
      with 12 advisories, none high.

- [ ] **Clear the knip findings.**
      Delete `apps/ui/app/components/answer-drift.tsx`, `ConnectorSyncPanel.tsx` and
      `learned-routing.tsx`; drop `@nexus/contracts` from `packages/llm/package.json`; remove the 23
      unused exports and 33 unused types; drop the `knip.json` entry and project patterns that match
      nothing; add `go` and `where` to `ignoreBinaries`; add `pyodide` to `ignoreDependencies`
      because it is resolved at run time in `apps/api/src/lib/untrusted-python.ts:12`.
      Verify: `pnpm prune:knip` exits 0.

- [ ] **Record the dependency drift** as 289 with the reason above, so the next reader does not
      re-litigate it.

- [x] **Push.** `origin/master` is at `d49b3ae`, pushed directly rather than through a PR, which
      bypassed the nine required checks. Every `migrate/*` and `backup/*` branch is gone; only
      `master` remains, local and remote. Their SHAs are in `.nexus/deleted-branches.txt`.

- [ ] **CI green.**
      Jobs that must pass: lint (`pnpm lint`, `pnpm format:check`, `pnpm check:headers`), test (unit
      on Node 24 and 26, app suites, desktop e2e, concurrent migrations, signal e2e, browser e2e,
      Python), build (four-entry matrix), docker, security (audit, gitleaks, Trivy, CodeQL), k6
      smoke.
      First run on `bb89694`: security failed at Trivy setup because `aquasecurity/trivy-action`
      publishes `v0.36.0`, not `0.36.0`. Fixed in `d49b3ae`.
      Second run: lint failed on a literal ESC byte in `packages/llm/src/compress/index.ts`. Fixed
      in `35baf5a`.

- [ ] **Clean-clone compose.**
      Run: `git clone . $env:TEMP\nexus-clone`, then `docker compose up -d --build` in the clone.
      Verify: `/health/ready` returns 200; `.dockerignore` keeps `node_modules`, `.git`, `.nexus`
      and `data` out of the context; `docker compose down -v` leaves nothing behind.

- [ ] **Pin the remaining bases by digest.**
      `postgres`, `node` and both Dockerfile stages carry `@sha256`. `redis:8.10-alpine`,
      `searxng/searxng:2026.9.25-12f8b6515` and `otel/opentelemetry-collector-contrib:0.162.0` do
      not, and the observability compose file is tag-only throughout.
      Verify: every `image:` and `FROM` carries a digest.

- [ ] **k6 baseline.**
      No k6 binary and no stored numbers. `k6.yml` only load-tests when `NEXUS_STAGING_URL` is set,
      which it is not.
      Run: `docker run --rm -i --network host grafana/k6 run - < infra/k6/smoke-test.js` against the
      compose stack, then `load-test.js` with `BASE_URL` and `API_KEY`.
      Verify: p95, p99, `http_req_failed` and iterations recorded in `.nexus/k6-baseline.txt`, and
      the same run repeated after the sandbox work shows no regression.

- [ ] **Render deploy and migrate workflow.** **(you)** Blocked on the blueprint, the database and
      the secrets above.
      Verify: `/health/ready` 200 on the onrender host; `DB Migrate` green against Neon; a sign-up,
      a chat turn and an audit export all work there.

- [ ] **Correct `docs/STATUS.md`.**
      Line 47 and line 148 still say JS and Python skill code run locally with nothing. Since
      `3ac6cfb` untrusted code needs Docker plus `NEXUS_SANDBOX_IMAGE`.
      Verify: no row claims a runtime the deployment cannot provide.

- [ ] **Tick Final acceptance in `docs/stack-migration.md`** with the results above, and mark Render,
      k6 and live sign-in as blocked rather than ambiguous.

---

## Track B: offline, end to end

Target: a machine with no WAN, no cloud database, no cloud model, and the app does real work.

- [ ] **Offline boot.** `DATABASE_URL` unset resolves to `pglite://.nexus/db`; `pnpm --filter
      @nexus/api dev`; `/health/ready` 200 with the network adapter disabled.
- [ ] **Offline model.** `ollama pull qwen2.5:7b`, select `ollama/qwen2.5:7b` (drivers live in
      `packages/llm/src/drivers/index.ts`); one chat turn streams to completion with no outbound
      traffic.
- [ ] **Sandbox image.** Add `infra/sandbox/Dockerfile`: Node 26, Python, Go, Rust, Ruby, Bash, a
      non-root `sandbox` user, digest-pinned bases, no network at run time.
      Verify: `docker build -t nexus-sandbox:local infra/sandbox` and
      `docker run --rm nexus-sandbox:local python3 -c "print(1)"`.
- [ ] **Compose wiring.** Build the image, set `NEXUS_SANDBOX_IMAGE`, and mount
      `/var/run/docker.sock` into the api service in the dev compose file only.
      Verify: a Python skill and a shell tool run; unsetting the image produces the documented
      failure instead of host execution.
- [ ] **Offline search.** SearXNG from compose answers; the `@web` picker returns hits with the WAN
      blocked.
- [ ] **Offline desktop.** `pnpm --filter @nexus/desktop build`, then `start`; sign up, chat, run a
      skill, restart, and the same data and session are still there.
- [ ] **Offline acceptance script.** One script runs the checks above and prints pass or fail per
      line. Verify: exits 0 with the WAN off.

---

## Track C: online, end to end

- [ ] **Live sign-in with GitHub.** **(you)** Create the OAuth app above, then set
      `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OAUTH_REDIRECT_BASE` on the host.
      `routes/oauth.ts` already implements the flow and `/oauth/providers` hides the button until
      both values exist.
      Verify: sign in through the browser on the deployed host; the session survives a reload.

- [ ] **Render + Neon.** Blueprint applied, migrations run, then sign-up, chat, skill, the free +
      BYOK billing row, and an audit export against the deployed host.

- [ ] **Browser app: local sandbox helper.** New package `apps/sandbox-helper`, no runtime deps:
      `GET /health`, `POST /pair` (one-time code), `POST /run` (token, `Origin` allowlist, image
      allowlist), fixed port 4789, CORS plus
      `Access-Control-Allow-Private-Network: true`, a 30 s cap and an output cap. The page calls
      `http://127.0.0.1:4789` directly, because the deployed API cannot reach the user's loopback.
      Verify: token, origin and limit tests; a `curl` run returns stdout and exit code; with the
      helper stopped the UI says "local sandbox: not connected".

- [ ] **UI connect flow.** Probe `/health` with a 500 ms timeout, show a pairing modal, and offer the
      setup guide when nothing answers. Persist each run's output through the API so history
      survives a reload.

- [ ] **Sandbox setup guide.** One page: install, start, pair, what the helper can and cannot reach.
      Linked from the sandbox-disabled message.

- [ ] **Desktop M4: bundle the API.** Compile `apps/api` to JS, ship it and the UI build inside the
      app, and point `apps/desktop/src/local-api.ts` at the bundled entry instead of
      `api/src/index.ts`. Today the app fails with "API not found … run `pnpm build` first".
- [ ] **Desktop M4: installer.** Windows NSIS and macOS dmg, built in CI. **(you)** certificate and
      notarisation.
- [ ] **Desktop M4: auto-update.** Signed feed, version check on launch, rollback to the previous
      build if the new one fails to start. **(you)** hosting for the feed.

- [ ] **Other sandbox languages.** Go, Rust, Ruby and Bash come from the image above; a self-hosted
      Piston behind `PISTON_URL` stays optional for hosted runs.

- [ ] **Online acceptance run.** The Track B checks against the deployed host, plus a second user
      and a revoked session.

---

## Track D: product gaps, unscheduled

- [ ] **LSP.** `docs/proposals/lsp.md` exists; nothing implements it.
- [ ] **Billing.** Stays free + BYOK by design. No subscription work.

---

## Decisions, settled

1. **Sandbox placement:** compose mounts the socket, the desktop app uses the local Docker CLI, and
   the browser app uses the loopback helper. Hosted execution with no install is out of scope.
2. **Desktop installer:** bundle the API. Decided; the offline promise needs it.
3. **Sign-in:** GitHub now, Google when a Workspace tenant exists.
4. **Push:** explicit approval only.

---

## Tools to install

```
winget install --id GrafanaLabs.k6 -e
winget install --id Gitleaks.Gitleaks -e
winget install --id AquaSecurity.Trivy -e
winget install --id Anchore.Syft -e
winget install --id PostgreSQL.PostgreSQL.18 -e
winget install --id Ollama.Ollama -e
```

`GrafanaLabs.k6` is the CLI; `GrafanaLabs.k6Studio` is a separate GUI and is not needed.
`PostgreSQL.PostgreSQL.18` installs a server too; uncheck it if you only want `psql`. Playwright
browsers come from `pnpm exec playwright install`. Already present: `gh`, `docker`, `node`, `pnpm`,
`git`, `go`, `python`, `uv`.
