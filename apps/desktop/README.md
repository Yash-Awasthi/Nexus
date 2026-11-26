<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nexus desktop

The Electron shell for the same product the website serves. The renderer is
`apps/ui` unchanged; this package owns the window, the privileged operations
behind the host bridge, and the navigation rules.

It has the shell and preload bridge, the local API with its own database, and
sync. The tray is here too: closing
the window hides it, so companies keep running on their schedules until "Quit
Nexus" in the tray menu, and a second launch shows the running app. It can also
build the API and UI it ships (`build:api`), package them with
electron-builder, and apply a signed update on quit.

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

The child runs `apps/api/src/index.ts` directly: every workspace package exports
its TypeScript source and uses only erasable syntax, so Node's own type
stripping loads the whole API without a compile step or loader.

### The packaged build

A checkout is not what an install has, so `pnpm --filter @nexus/desktop build:api`
produces everything the shell needs to run without one:

```bash
pnpm --filter @nexus/ui build
pnpm --filter @nexus/desktop build:api
```

`scripts/build-desktop-api.mjs` bundles the API and every `@nexus/*` package into
`apps/desktop/resources/api`, stages the production npm dependencies beside it,
copies the database migrations, and copies the built UI to
`apps/desktop/resources/ui`. The shell prefers those two directories whenever
they exist and falls back to the checkout otherwise, so `dev`, the tests and the
e2e run are unchanged.

The bundle is JavaScript rather than TypeScript because Node's type stripping
does not apply inside `node_modules`, where a deployed tree keeps its workspace
packages.

The embedded database is migrated at boot, so a first launch asks for a local
account (email and password) and keeps its session in the OS keychain. PGlite
loads pgvector, so memory is searched in the embedded database the same way a
server does it.

To point the shell at something already running instead:

```bash
pnpm --filter @nexus/api dev     # API on :3000
pnpm --filter @nexus/ui dev      # renderer on :5173, proxies /api to the API
NEXUS_DESKTOP_URL=http://127.0.0.1:5173 pnpm --filter @nexus/desktop dev
```

| Variable                  | Effect                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `NEXUS_DESKTOP_URL`       | Load the renderer from here; skips the local API.               |
| `NEXUS_API_URL`           | Same, for an API that also serves the SPA.                      |
| `NEXUS_SYNC_URL`          | Cloud deployment to sync with. Unset means local-only, no sync. |
| `NEXUS_UPDATE_FEED_URL`   | Signed update feed; unset disables updates.                     |
| `NEXUS_UPDATE_PUBLIC_KEY` | Ed25519 SPKI (base64 or PEM) that signs the feed manifest.      |
| `NEXUS_UPDATE_LOG`        | `off` (default) or `debug`; never prints feed URLs.             |

The two update values are also read at **package time** by
`scripts/write-update-config.mjs`, which writes `dist/update-config.json` into
the asar. An installed app has no environment, so that file is what makes its
updater work; the variables override it for dev and tests. A build without both
files the updater disabled rather than guessing a feed.

```bash
NEXUS_UPDATE_FEED_URL=https://updates.example.com/desktop \
NEXUS_UPDATE_PUBLIC_KEY="$(cat update-public.pem)" \
  pnpm --filter @nexus/desktop dist
```

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

## Packaging and updates

`pnpm --filter @nexus/desktop dist` builds the shell, its bundled API and the UI,
then electron-builder writes a per-user NSIS installer on Windows or a dmg on
macOS to `dist-installers/`. Signing is environment-only and never committed:
`CSC_LINK`/`CSC_KEY_PASSWORD` for the platform certificate, and
`APPLE_ID`/`APPLE_TEAM_ID`/`APPLE_APP_PASSWORD` for notarisation
(`scripts/notarize.cjs` submits and staples, then skips when they are absent).

Updates read two files from `NEXUS_UPDATE_FEED_URL`: `manifest.json` and its
detached Ed25519 signature `manifest.json.sig`. `scripts/release/build-update-manifest.mjs`
writes both from a directory of installers; the release workflow publishes them
with the installers. The client refuses an unsigned manifest, a non-Ed25519 key,
only `https` (loopback may use `http`), an artifact over its sha256 or the 2 GiB
cap, and a file outside the update directory. A staged installer is re-hashed
immediately before it runs on quit. The last confirmed installer is kept: if the
new build never reaches `/health/ready`, the main process restores it once and
relaunches. A feed that is unreachable adds no launch delay — the check starts
after the window is shown; `pnpm --filter @nexus/desktop measure:launch` prints
the window time with and without a feed that never answers.

A downloaded release directory can be audited without opening the app:
`pnpm release:verify --dir <folder> --public-key update-public.pem` checks
`SHA256SUMS`, the manifest signature and every artifact's size and sha256.
`pnpm check:release` statically checks the builder, workflow, feed and key wiring
before a tag exists.

The installer ships the API's staged production `node_modules` beside the
bundle, because the bundle keeps npm packages external; on Windows that is
~1.4 GB unpacked and a ~314 MiB installer. Dropping a dependency directory makes
the packaged app fail at startup (`Cannot find module '@electric-sql/pglite'`).

## Security posture

`contextIsolation` is on, `nodeIntegration` is off and the renderer runs in the
Chromium `sandbox`, so it holds no Node handle. `pnpm build` bundles the preload
and its bridge into one file with rolldown, since a sandboxed preload can require
only `electron` and a few Node builtins. External
navigation and `window.open` both hand the URL to the user's own browser rather
than to a privileged window.
