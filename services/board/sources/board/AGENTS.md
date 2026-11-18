# agents guide

board is one npm package, `@vercel/board` (`packages/board`): `board()`, the handle that
serves a board and acts on it, its backends, and the CLI (`board`, alias `vb`). [SPEC.md](./SPEC.md) is
the design; read it before changing behavior.

## run it

```bash
pnpm install
pnpm check          # build + typecheck + test
pnpm test           # vitest: unit, in-process server, and CLI end to end
```

CI runs `pnpm check` on every PR and on `main` (`.github/workflows/check.yml`);
its `check` job is the status a PR needs before it can land.

Tests run on the local board's engine (`packages/board/test/harness.ts`):
`memory()` for the store, `memoryBlob()` for files, no scheduler unless a test
passes one, a local test issuer, and the test project as the board's
environment. Auth runs real `jose` verification against an injected JWKS;
there is no bypass. What doesn't depend on board's version (the test project,
its keys, the tokens they sign, and `caller`) is `test/tokens.ts`.

Every test you write, change, or review gets the test-behavior skill
(`.claude/skills/test-behavior`): break what it
claims to test and see it fail, and pin no internals a user can't observe.

## release it

A change people will notice gets a changeset (`pnpm changeset`); its PR is
titled and described as [pr titles and descriptions](#pr-titles-and-descriptions)
says. On `main`,
`.github/workflows/release.yml` opens a "Version Packages" PR; merging it
publishes `@vercel/board` to npm by trusted publishing (OIDC, no token). npm attaches
provenance to a release on its own, which it does only from a public repo: the
workflow has no flag for it. The CLI and the API read their version from
`package.json`, so never edit `src/version.ts` to bump it.

To try a commit before it's released, install its tarball from the
**vboard-preview-publisher** deployment on the PR (`apps/preview-publisher`, a
static Vercel project): its page has the `pnpm add`
line, pinned to that deployment. Nothing goes to npm; see its
[README](./apps/preview-publisher/README.md).

## other private repos

Never link or cite another private Vercel repo: not its PRs, issues, commits,
or files, and not in code, comments, tests, fixtures, docs, changesets, commit
messages, or PR titles and descriptions. Say what the other side does instead
("Vercel's API answers 404 for `/schedules`"), and use `acme/web` where a
fixture or an example needs a repo.

## pr titles and descriptions

People read these on Slack and in the board thread before the code, so both
say plainly what changes, and briefly.

**Title:** `<type>(<area>): <what it does>`, in the imperative, about 60
characters at most: `fix(store): split big redisTables writes into bounded scripts`.

- `type` is `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, or `chore`,
  with `!` when it breaks someone: `feat(protocol)!: …`.
- `area`, when one fits, is where people would look: `cli`, `sdk`, `protocol`,
  `sync`, `backend-local`, `backend-http`, `backend-vercel`, `inspector`,
  `docs`.
- No narration ("X does Y", "X is Y") and no second clause: two changes are
  two PRs.

**Body:** one line on what it does and for whom, opening with the link to the
board thread, Slack thread, or issue it came from when there is one. Then four
answers, each `none` when nothing applies, so a reviewer sees at a glance what
to look at:

```markdown
- **Users:** none | the new or changed command, flag, output, or SDK call; "breaking" if it is.
- **Protocol / backends:** none | new or changed routes and methods, what a backend must implement, conformance checks added.
- **Performance / I/O:** none | what each affected call now costs: board reads and writes, platform calls, polling, payload size.
- **Tests:** what's covered and at what level (the CLI as a subprocess, an in-process board, the real API), and what's faked and why.
```

Then `### Users` and `### Protocol / backends` for the answers that need more
than their line, and `### Open` for tradeoffs or follow-ups a reviewer must not
miss. Nothing else.

- **Code, not prose.** Users get a transcript pasted from a real run (trimmed,
  never retyped) or the SDK call with only the lines that matter; the protocol
  gets signatures and shapes (`GET /links?url= → ThreadView`). A breaking
  change says who breaks and what to do instead.
- **Imports, always.** Every SDK sample starts with its imports, each
  `@vercel/board/*` one included, before and after alike: which entry point a name
  comes from is part of the API, and a reviewer judges it from the sample
  (`import { channels, slack } from '@vercel/board/sync-slack'`).
- **Evidence matches the claim.** A bug fix names the test that fails without
  it, and shows the wrong output on `main` beside the right one. A UI change
  gets a screenshot, or a short video for a flow. Mocking board's own code
  doesn't count as testing it.
- **One screen.** One sentence per fact, no paragraph over three lines, and
  nothing the diff already says: no file lists, no renames nobody calls.
- **Users is `none` exactly when there's no changeset.**

The pr-description skill (`.claude/skills/pr-description`) says how to get the evidence where it runs, with an example.

## swarm (`templates/swarm`)

A template people fork for a swarm of agents on one queue. It stands alone: it
runs the `@vercel/board` release on npm, not this checkout, and `board()`, so
the team's board, or `BOARD_URL`'s. Keep it generic: no names, teams, boards, or
URLs of ours, and `acme/web` where it needs a project. Run it against
`vb serve`, never a team's board.

- **The queue is the board's tasks** (`board.tasks`, `vercel board tasks`): a
  root is a task, and the board keeps who holds it, what it waits for, and how
  it ended. `JOIN.md` gives agents the steps as `vercel board tasks` commands
  (Vercel CLI 66.2.0 or later), `scripts/worker.ts` takes the same ones from
  the `@vercel/board` handle, and the sandboxed runner (`sandbox/runner.ts`)
  runs them with the package's own CLI, which reaches the run's board by URL
  under the sandbox's network policy; change one and change the others.
- **Runs are launched from the page** (`app/page.tsx`, the routes in
  `app/api`, `lib/run.ts`): agents in Vercel Sandboxes, one per ready task.
  The app trusts only what the deployment and its `agent-N` profiles wrote on
  the board (`ownWrite`, `profileOfSelf`); labels anyone may write never decide
  a run's identity, its state, or what its agents do.
- **The live view** (`app/live`). A snapshot (`lib/swarm.ts`) reads the
  newest messages, then one `threads` read per task state by its
  `board.task` label, the finished states with a limit of 25. It reads threads
  and not `tasks.list`, which lists oldest first: the page wants the newest
  finished. Keep each label filter to one value: Vercel's board
  indexes only that, and pages through every thread in the swarm for
  `a|b` or a bare key. Nothing is kept between snapshots.
  `app/api/live` long-polls the swarm's events and sends a snapshot over
  server-sent events after a change, at most one every 5 seconds, from a
  snapshot every viewer on the instance shares (`sharedSnapshot`). The browser
  holds no credential.
- `pnpm seed` makes sample tasks, one plan per channel, a review that waits for
  its fix among them. `pnpm worker <name>` is a stand-in agent that claims,
  logs, renews, and completes them, to check the page without a model.
- `pnpm test` (`test/swarm.test.ts`) runs on `local({ memory: true })`: what a
  snapshot holds for each state, a task made and finished between two
  included, a race for one claim, and a task readied by the one it waited for.
  The claims' own promises (a lease that runs out, a fenced write) are the
  board's, and its conformance suite checks them.

## the docs (`packages/board/docs`)

Markdown in the package, so it ships on npm (`files` has `docs`) and agents can
read it in `node_modules/@vercel/board/docs`. `docs/index.md` is the landing
page's body.

- **Plain GFM, no HTML.** Frontmatter is `title` and `description` (YAML: quote
  a value with `: ` in it). The description renders under the title, so a body
  starts with a `##` heading or a code block. Fences take a filename after the
  language (```` ```ts app/api/board/[[...path]]/route.ts ````) and only
  a small set of languages; ```` ```package-install ```` takes one
  `npm i …` line. Callouts are GitHub's `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`,
  and under a `## FAQ`, each `###` question folds into a `<details>`.
- **Pages link by relative file path** (`../02-sync/03-slack.md#files`), so they
  read the same on GitHub and in `node_modules`:
  `packages/board/test/docs-links.test.ts` checks every link and anchor in
  this checkout's docs.
- **Filename prefixes order the sidebar** and are stripped from URLs:
  `02-sync/03-slack.md` is `/sync/slack`, in the group "Sync".
- **A2's voice:** present tense, as if it ships today; short sentences; no
  em-dashes, hype, or filler; "board" lowercase. Samples are paste-complete,
  every live line is real API, and userland is commented out. The docs describe
  the code: where SPEC.md and the code disagree (read cursors aren't built), the code
  wins. A change people will notice updates its page.

## the inspector (`vb inspect`, `src/inspect/`)

A local web UI for any board, reading and writing as the CLI's identity. Check it
with `agent-browser` against `vb inspect --no-open`; try writes against
`vb serve`, which syncs nothing: a board with sync set up posts to Slack and
GitHub.

- **The page is just another handle.** `server.ts` serves the page, its
  bundle, and `/board/*`, a proxy that adds your credentials; the page is
  `board({ backend: http(proxy, { fetch }) })`, on the internal `http()` of the
  default builds, its `fetch` sending the per-run token. The page needs no inspector-specific API; if
  it wants something, add it to the board's API.
- **`app/board.ts` is the page's data, and nothing else is.** One handle, and
  every read and write a `team.*` call on it. Who it writes as is
  `team.as(profile)`: the proxy reads the board's own `x-board-profile`, and a
  request that names none is yours. It follows the feed with `team.events`,
  whose `onState` says whether it's connected. Its one import a user can't make
  is `http()`.
  If the page wants something the handle doesn't offer, leave it out and add it
  to the handle, never to the page.
- **Its core is the build-a-ui guide's samples.** Each `// #region guide
  inspector/<name>.ts` in `app/board.ts` and `app/store.ts` is quoted by
  `docs/03-guides/07-build-a-ui.md`, to the letter: `test/docs-guide.test.ts`
  fails when either drifts, so change both.
- **State lives in `app/store.ts`, pure and tested.** Views merge by their
  `version` (an older view never replaces a newer one); your writes are
  overlays until the stream confirms them. Components render from it. A claim's
  token is a secret: it stays in `board.ts`'s memory, never in the store or in
  storage, and the store holds only which claims are live.
- **A view says what the board answered.** A read that fails shows the
  board's words where its content would be, a 501 like any other. What a viewer
  may do to a task is `store.moves`, by the board's rules; the board still
  decides each write.
- **Content in the sidebar, configuration in settings.** Activity, tasks, and
  channels are the sidebar. Access, schemas, schedules, watchers, and sync are
  tabs of one view at `/settings/<section>`, reached from the sidebar's foot.
  Links are text, buttons act, and a view says little.
- **The proxy acts as you, so it trusts nothing but its own page.** It binds
  127.0.0.1, rejects any `Host` that isn't its own (DNS rebinding), and its own
  on a request a proxy forwarded (a caller behind one can send it), requires the
  per-run token on every `/board` request and the page's `Origin` on writes.
  Keep all of them. That's why attachments render from `blob:` URLs: the page
  fetches each file with its token, since an `<img>` can't send one.
  `vb serve` answers it on the board's own port (`createInspector`'s handler),
  and at a `--tailscale` host its proxy acts as the visitor Tailscale names
  (`visitor`), never as you: one it can't name gets a 401, not your access.
- **The bundle is built** into `dist/inspect/app.js` by `tsdown` (React
  included), which the standalone CLI reads where board is installed. Only it
  has `inspect`, so no UI ships in a CLI that bundles board's (`vercel board`).
  `pnpm test` builds first; running from source finds it in `dist`.
- **It's Just Chat's UI, ported.** Base UI (`@base-ui/react`) for menus,
  context menus, popovers, and autocompletes; lucide icons; plain CSS in
  `style.ts` with Just Chat's tokens. Right-clicking text keeps the browser's
  menu (`nativeMenu`); the row's space opens ours.
- **Just Chat's invariants hold:** the default cursor everywhere but text
  (buttons and sidebar links included), no smooth scrolling, hairlines only
  under headers, the thread pane's open state in the URL, typing anywhere
  focuses the composer, and live updates never move what you're reading or
  clobber what you're typing.

## cli design (`src/cli/`)

The CLI reads like the docs site: plain, quiet, nothing extra. Output is
for a person at a terminal first; `--json` is for programs.

- **Say what happened, then stop.** One line per fact, in lowercase phrases
  (`removed`, `not installed`). No banners, no "Done!",
  no recap of what the command was asked to do.
- **No emoji, no color, no box drawing.** Plain text reads the same in every
  terminal, log, and paste.
- **Columns, not colons.** A row is its subject, then two spaces, then the
  value (`board  https://…`); pad the subject when rows stack, so values line
  up.
- **Group by subject.** When a command touches several things (agents,
  files), each gets a heading line (name, two spaces, path) and its details
  indented two spaces under it, with a blank line between groups.
- **Paths as people write them.** `~/.claude/settings.json`, not the expanded
  home directory.
- **Say it in words, not in config.** Name what changed (`update, reply, and
  read run without asking`); don't echo the raw rules, commands, or JSON that
  were written. Print config only when the person has to paste it, indented
  four spaces and paste-complete, with its instructions as comments in it.
- **Fit 80 columns.** Shorten a line before wrapping it; a long path or value
  can run over, prose shouldn't.
- **Errors are data, shaped like the Vercel CLI's** (`src/cli/failure.ts`): a
  class that fixes the exit code, a `reason` to branch on, a headline that says
  what failed and why, and at most two ways out, each a command as argv or a
  sentence. `vb` prints them on stderr as `error: <headline>`, with each way
  out two spaces in after a blank line; with `--json`, as one JSON document.
  `vercel board` shows the same data as its own (`createApp({ onError })`). An
  error the handle raised itself (`origin: 'handle'`) says what and why in
  `message` and what fixes it in `hint`. What a board answered (`origin:
  'board'`) is said by what the command was doing, the board's words only under
  it and in `data`, never in what to run: a board can answer with any code. A
  handle's message shows a value a board gave only when it fits its shape (a
  project ID, a URL).
- **`--json` is one document**, keyed by what it holds (`{ threads, cursor }`,
  `{ message, outcome }`), with a write's `warnings` in it. Only `tail`, which
  streams, prints a line per event.

## layering

API → `board()` → CLI. The CLI makes no HTTP calls of its own; everything goes
through a handle from `board()`, and `board()` only ever calls the backend's
methods, and nothing reaches around them. The policy is `board()`'s, in one
place on every backend: it routes and validates each request, verifies its
caller (`authenticate`, `oidcTokens()` from `@vercel/board/access` by default),
works out what it may do (its people and its own deployments everything,
anyone else what the board's grants give), runs the
`middleware`, and calls the backend with the caller it verified
(`{ identity, origin }`), which the backend trusts because only `board()`
makes one. Nothing with side effects runs for a request before its access
allows it. With no backend, `board()` is the team's board in Vercel's
API (`vercel()`), or with `BOARD_URL` set, `http()` to that board: both
internal, and neither exported.
`local()` keeps a board in this process on an internal engine, A2's log
(`src/server/a2.ts`, never in the public API or its types): SQLite under
`.board/` or memory, its files beside it, and a scheduler in the process. The
engine without a scheduler, as some tests run it, runs its consumers in the
request that wrote and answers scheduling with 501 `no_scheduler`; without a
blob store, it keeps no files (501 `no_files`). What it does outside requests
asks `board()`'s policy through the binding (`accessNow`), and what it writes
for someone (a schedule's send) goes through the binding's handle, so the
middleware sees every write once. A board
on another one, Vercel's (`vercel()`) or the one at `BOARD_URL` (`http()`),
answers only wake-ups and webhooks, so a repo links the team's board itself.
Request
schemas live in `src/api/routes.ts` and are shared by the server and the
handle. Nothing on the way to a handle on Vercel's board imports Node:
credentials go in `board({ fetch })`, whose Node default (`vb`'s) lives in the
`node` build of `@vercel/board`. Watchers and sync run in either
build: the engine loads when it's first used, and it and `SyncProvider` import
nothing from Node; the Chat SDK adapters do (`test/browser.test.ts` checks).
A2 is bundled: tsdown inlines what board runs of it into `dist` (`deps.alwaysBundle`), so
installing board installs no `experimental-a2`, and only `local()` loads it. The Chat SDK,
its adapters, and `@vercel/connect` are optional peers that only the `sync-*` subpaths load.
Neither reaches a handle on Vercel's board, its types included (`test/browser.test.ts` and
`test/types.test.ts` check).

## invariants

- **No pre-AGI mechanisms.** Don't hard-code behavior a model would decide
  better in context: canned decorations, keyword or emoji triggers, heuristics
  that guess what a message means and rewrite it. Deliver what the author
  wrote and give agents the tools; if an agent wants to quote what it's
  answering, it writes the quote. (That's why replies sync without an
  automatic quote line.)

- **One log.** On a local board, every board fact is an event in A2 session `board`. Messages and
  the sync state are read from tables the `board-tables` consumer keeps from it
  (`src/store/`), built with `foldMessages` and `foldSync`; smaller views are reducers in
  `src/contract/reducers.ts`. Nothing writes the tables but that consumer and
  the board's own writes, each event once: whoever applies it claims its index.
  Bookkeeping that people don't read (cursors, raw platform events) belongs in
  side contracts, not the board log.
- **The tables are one interface.** A local board reads through `MessageTables`
  (`src/store/types.ts`), in board terms, on SQLite (`src/store/sql.ts`).
  `test/tables.test.ts` is its conformance suite: random histories against the
  full-state fold, every filter, and writers and the consumer taking turns, in a
  file and in `memory()`. A change to either keeps it passing, and a new backend
  joins its `BACKENDS`.
- **Folds mutate in place.** A2 clones state at every read and snapshot
  boundary, so an event costs O(1). Never share a fold's state object outside
  the fold.
- **Provenance is server-authored.** `by`, `mentions`, and sync fields are never
  read from a request body.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no parameter properties,
  enums, or namespaces. Tests run the CLI from source with Node's type stripping.
- **The CLI is a product surface.** Errors are the Vercel CLI's, as data (see
  [cli design](#cli-design-srccli)). Exit codes: 0 success, 1 error (a `wait`
  that timed out included), 2 misuse (no board to use included), 130 when
  Ctrl-C stops `tail` or `wait`.
