<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nexus desktop

The Electron shell for the same product the website serves. The renderer is
`apps/ui` unchanged; this package owns the window, the privileged operations
behind the host bridge, and the navigation rules.

Milestones M1–M3 of `docs/design/nexus-desktop.md`: shell and preload bridge,
the local API with its own database, and sync. Of M4 the tray is here: closing
the window hides it, so companies keep running on their schedules until "Quit
Nexus" in the tray menu, and a second launch shows the running app. An installer
and auto-update are not: the API runs from the workspace with the `tsx` loader,
so a package first needs the API bundled into one tree, then code-signing
certificates and a release channel for updates, which are operator decisions.

## Running it

With nothing configured, the shell starts its own API and everything runs on
this machine:

```bash
pnpm build                       # apps/api and apps/ui must be built first
pnpm --filter @nexus/desktop dev
```

That boots the real Fastify service as a child process on a free loopback port,
against an embedded Postgres (`@electric-sql/pglite`) under the app's data
directory, serving the built `apps/ui` from the same origin. Every `/api/*` call
the renderer makes is same-origin, exactly as in a browser tab, and no server
and no network are involved.

The child runs with `--import tsx/esm`. That is not a convenience: 39 workspace
packages point `main` at their TypeScript source, and Node's own type stripping
rejects the parameter properties several of them use, so plain
`node dist/index.js` dies on the first such import.

The embedded database is migrated at boot, so a first launch asks for a local
account (email and password) and keeps its session in the OS keychain. Vector
memory falls back to in-memory — `PgVectorStore` needs a real Postgres with
pgvector — and says so.

To point the shell at something already running instead:

```bash
pnpm --filter @nexus/api dev     # API on :3000
pnpm --filter @nexus/ui dev      # renderer on :5173, proxies /api to the API
NEXUS_DESKTOP_URL=http://127.0.0.1:5173 pnpm --filter @nexus/desktop dev
```

| Variable            | Effect                                                          |
| ------------------- | --------------------------------------------------------------- |
| `NEXUS_DESKTOP_URL` | Load the renderer from here; skips the local API.               |
| `NEXUS_API_URL`     | Same, for an API that also serves the SPA.                      |
| `NEXUS_SYNC_URL`    | Cloud deployment to sync with. Unset means local-only, no sync. |

```bash
pnpm --filter @nexus/desktop smoke   # boot, print the capability list, exit
pnpm --filter @nexus/desktop test:e2e # drive the built app from a clean data directory
```

The smoke run needs no renderer: it points the shell at an unreachable port on
purpose, so it also proves the shell says so on screen instead of showing a
blank window.

## The host bridge

The renderer asks what its host can do, never which host it is. This shell
declares six capabilities in `src/bridge.ts`:

| Capability       | Methods                                                                   | What it does                                                                                          |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `localAccount`   | `signIn`, `signInWithPassword`, `getSession`, `refreshSession`, `signOut` | Owns the account session: the token lives in the OS keychain and the renderer gets an in-memory copy. |
| `providerSignIn` | `connectProvider`, `isProviderConnected`                                  | Links an LLM provider through an app-owned browser window instead of a pasted key.                    |
| `glass`          | `toggleGlass`                                                             | Translucent window mode.                                                                              |
| `councilSync`    | `setCouncilMembers`                                                       | Writes council membership to `userData/council.json`.                                                 |
| `runMode`        | `getRunMode`                                                              | Says whether the API is `local-only` or `cloud`, and at which origin.                                 |
| `sync`           | `syncNow`, `getSyncLedger`                                                | Runs one sync with the cloud, and reports what past runs moved.                                       |

Everything else the renderer can do — deliberations, threads, memory — runs over
HTTP against the local API, exactly as it does in a browser tab, so this shell
does not reimplement it. A method reached without its capability throws rather
than silently doing nothing.

## Sign-in

A local account signs in with email and password: the main process posts them to
the local API and seals the session it gets back. Provider sign-in opens the API's OAuth entry point in a separate window with its own
session partition. The callback is never loaded: the main process cancels that
navigation and fetches the callback itself, so the authorization code is spent
here rather than rendered into a page. What comes back is sealed with
`safeStorage` and written to `userData/session.sealed`, mode 600.

There is no plaintext fallback. If the OS refuses to provide encryption the
sign-in fails, because a token written unencrypted to a file is worse than a
user who has to sign in again. Closing the window cancels cleanly: nothing is
fetched and nothing is stored. Refreshing the access token is an HTTP call with
no window at all.

Provider links work the same way, except the API completes the exchange and
keeps the provider tokens — the desktop never holds a provider credential.

## Sync

`syncNow` pulls the remote's operations since the stored cursor, applies the
ones this machine has not seen, and pushes back what the remote has not seen —
over the same `/api/v1/session-sync` endpoints the cloud already serves.

A key changed on both machines is settled by logical time, and on a tie by
device id, so both sides reach the same answer without coordinating. The value
that loses is **not** discarded silently: it is recorded in a ledger entry
naming the key, which side won, and what the other side had. `getSyncLedger`
returns the last fifty runs, so "did my work reach the other machine" has an
answer rather than a reassurance.

A run that fails records the error and leaves the cursor where it was, so the
next run retries exactly what did not land.

The local API key that authenticates the renderer to the loopback service lives
in `userData/local-api-key`, mode 600. It is not an account credential — those
stay in the OS keychain.

## Security posture

`contextIsolation` is on and `nodeIntegration` is off, so the renderer holds no
Node handle. `sandbox` is off only because the preload resolves a sibling module;
bundling the preload is the upgrade path, marked in `src/main.ts`. External
navigation and `window.open` both hand the URL to the user's own browser rather
than to a privileged window.
