import type { BoardEventView } from '../api/routes.ts'
import { BoardError, createBoardClient, eventsState, type BoardClient, type EventsOptions, type NewTaskOptions, type ProfileOption, type TaskOptions } from '../client/client.ts'
import { derivedId } from '../client/ids.ts'
import type { SyncProvider } from '../sync/provider.ts'
import { SYNC, type Backend, type BoardBinding, type Caller, type SelfCaller, type Subscription, type SyncEntry } from './backend.ts'
import type { Middleware } from './middleware.ts'
import { createPolicy, type Policy, type PolicyOptions, type Serving } from './policy.ts'
import { createServe, type PlatformCaller, type Serve } from './serve.ts'
import type { Watcher } from './watcher.ts'
import { HttpError } from './errors.ts'
import { canText, compileAccess, InvalidCan, parseCan, type Can } from './access.ts'
import { formatProfileHeader } from '../contract/profile-header.ts'
import { boardPolicy, canHeader, PROTOCOL_ROUTES, withoutToken, type SandboxInput, type SandboxPolicy, type SandboxPolicyOptions, type SandboxReach } from './sandbox.ts'

/**
 * `board()`'s options: where the board lives, who may use it and what its writes go through, and
 * what runs here. The backend keeps or reaches the log; the policy is the board's.
 */
export type BoardOptions = PolicyOptions & (BackendOptions | DefaultOptions) & {
  /**
   * Which of the team's boards this is, by its name: `security` is the team's board named
   * security. Without one, the team's default board. A name is 1 to 64 characters with no `/`, and
   * matches whatever its case. The backend reads it when board() binds it: `vercel()` finds that
   * board, a board on `http()` is the one at its URL, whatever its name.
   */
  name?: string
  /**
   * With `name`: whether to make that board when the team has none by that name, whoever calls (a
   * deployment, or a person: `next dev` with a login, a script). It does by default; `ensure: false`
   * only finds one, and a name the team has none for fails with 404 `no_board`. `vb` passes false
   * unless `--ensure` is given, so a typo at a terminal makes no board.
   */
  ensure?: boolean
  /**
   * Whose board this is: another team's, by its ID (`team_…`) or its slug, with `name` or without
   * it for that team's default board. Without one, the team the environment finds: in Node, the
   * deployment's, `VERCEL_ORG_ID`, or the linked project's.
   */
  team?: string
  /**
   * Runs on every post and edit before it reaches the backend, whatever it came from: requests (a
   * board on `http()` using this one included), watchers, schedules, the handle, and sync's imports.
   * Each calls `next()` to pass the write on; one that doesn't drops it.
   */
  middleware?: readonly Middleware[]
  /** Tails the board runs for you, keyed by an id you choose: `{ triage: { tail: 'firehose', run } }`. */
  watch?: Record<string, Watcher>
  /**
   * Two-way sync, keyed by a name you choose: `{ slack: slack('slack/acme', channels({...})) }`. It
   * runs here, wherever the board lives: webhooks land at `<board>/webhooks/<key>`, and what the
   * board's channels say goes out to the platforms. On `http()`, the board it uses must let this
   * deployment `sync` in those channels.
   */
  sync?: Record<string, SyncProvider>
  /**
   * The board's public URL, which every token's audience must equal. Inferred from requests
   * otherwise only on Vercel, which routes a request to a deployment only for its own domains, and
   * in development: elsewhere a request's sender chooses its Host, so a production board without
   * one verifies no tokens.
   */
  url?: string
  /** The mount path, e.g. `/api/board`. Inferred from requests otherwise: the shallowest one they show. */
  basePath?: string
  /** SSE streams close after this long, before the platform's limit; clients reconnect. */
  streamMaxMs?: number
}

/**
 * The handle on a board: its methods act as the board's caller, through board(), which calls the
 * backend's methods, and `fetch` serves it. Over `http()` the caller is whoever its `fetch`'s
 * credentials say, with the profile `BOARD_PROFILE` names; on a board it keeps
 * (`local()`), its own code, as `board:client`.
 */
export type Board = BoardClient & {
  /**
   * The board's HTTP handler, for a route file (`export const GET = team.fetch, POST = team.fetch`)
   * or any runtime that takes one function.
   */
  fetch(request: Request): Promise<Response>
  /**
   * The handle, acting with `profile`: `<principal>+<profile>` over HTTP, `board:client:<profile>`
   * on `local()`. `null` acts as yourself, outside any agent session. With `can`, the board holds
   * every call it makes to that, as it holds a sandbox to its policy's `x-board-can`: an agent's tool
   * that runs `vb()` on `team.as('fixer', { can: ['read', 'post'] })` can't read sync's inbox or
   * change grants. A narrowed handle's own `as()` and `sandboxPolicy()` stay inside its `can`.
   */
  as(profile: ProfileOption, options?: AsOptions): Board
  /**
   * A Vercel Sandbox network policy that hands this board, and nothing else, to a sandboxed agent:
   * `Sandbox.create({ networkPolicy })` takes it. The sandbox's proxy adds the credential (this
   * deployment's own OIDC token, or `token`), the profile (`profile`, or this handle's from `as()`),
   * and `x-board-can` (`can`, or read, post, react, and label everywhere) to its requests for the
   * board's own routes, so none of them enters the sandbox; every other host is blocked. Spread
   * `allow` beside your own hosts' rules to merge them. An OIDC token dies with the function that got
   * it: hand the sandbox a new policy (`sandbox.update({ networkPolicy })`) before it expires.
   */
  sandboxPolicy(options?: SandboxPolicyOptions): Promise<SandboxPolicy>
}

/** What `as()` takes beside the profile. */
export type AsOptions = {
  /**
   * What the handle may do at most, as `x-board-can` narrows a request: a `can` (`{ 'dev/': ['read',
   * 'post'] }`, `['read']`) or its header form (`dev/=read,post`). It only narrows what this
   * deployment may do, and what the handle it's called on may: never sync's records, watchers'
   * registrations, or what `manage` does unless it says so. Without one, the handle's own.
   */
  can?: Can | string
}

/** A board on a backend you pass, which says how it reaches the board itself. */
type BackendOptions = {
  /**
   * Where the board lives: `local()` from `@vercel/board/backend-local` keeps it in this process,
   * or a backend of your own. By default, Vercel's board for your team, the one `name` names, or
   * with `BOARD_URL` set (in Node), the board at that URL.
   */
  backend: Backend
  fetch?: never
}

/** A board on the backend board() picks: Vercel's, or with `BOARD_URL` set, the board at that URL. */
type DefaultOptions = {
  backend?: undefined
  /**
   * How requests reach Vercel's API, with credentials it takes: a token for the team. In Node it
   * defaults to the deployment's OIDC token, `BOARD_TOKEN`, a GitHub Actions job's OIDC token, or your Vercel login,
   * never `VERCEL_TOKEN`; elsewhere, a browser say, pass one. A board at `BOARD_URL` gets the credentials `vb` sends it instead.
   */
  fetch?: typeof fetch
}

/** What a build of board gives board(): Node's finds boards, tokens, and the board's project in the environment. */
export type Runtime = {
  /**
   * The backend for a board() given none: Vercel's board, through `fetch` when it's given, or in
   * Node with `BOARD_URL` set, `http()` to that board.
   */
  backend(fetch: typeof globalThis.fetch | undefined): Backend
  /** Loads the sync engine, only for a board that syncs. */
  sync: () => Promise<typeof import('../sync/engine.ts')>
  /** Loads what the policy finds in the environment, the first time a board serves: null where nothing does, so pass `authenticate`. */
  serving: (() => Promise<Serving>) | null
  /** What a sandbox's requests to this board, at `url`, carry from this deployment: `token`, or its own OIDC token. Null where nothing finds one. */
  sandbox: ((url: string, token: string | undefined) => Promise<Record<string, string>>) | null
}

/** What the board's pipeline shares with its handle. */
export type BoardContext = {
  options: BoardOptions
  backend: Backend
  runtime: Runtime
  /** Who may use the board, and what each may do. */
  policy: Policy
  /** The mount path, as the last request that reached a route had it. */
  state: { learned: string | null }
  ownUrl(): string | null
  /** An in-process client through the board, as `caller`: its posts are idempotent per trigger. */
  clientAs(caller: Caller | PlatformCaller, trigger: string | null): BoardClient
  /** The handle, acting as `caller`: a watcher's, the middleware's, or a schedule's creator's. */
  handleOf(caller: Caller, trigger: string | null): Board
}

const hostChecked = new WeakSet<BoardOptions>()

/** `options`, for a board behind a server that lets a request name only hosts it allows, as `vb serve` does. */
export function hostCheckedBy<T extends BoardOptions>(options: T): T {
  hostChecked.add(options)
  return options
}

/** Whether a board without `url` can take it from a request's Host: on Vercel, or behind a server that checks Host. */
export const hostTrusted = (options: BoardOptions): boolean =>
  hostChecked.has(options) || (typeof process !== 'undefined' && process.env.VERCEL === '1')

/** A handle's own, with every request it makes ended by a signal: what `vb()` runs a command on. Global, so another copy of board finds it. */
const STOPPED_BY = Symbol.for('@vercel/board/stopped-by')

/**
 * `board`, with each request it makes ended by `signal`: the backend's call gets it, and the request
 * rejects with its reason when it fires, whether or not the backend heeds it. A request already
 * sent may still have done what it asked. Null for a handle board() didn't make.
 */
export function stoppedBy(board: Board, signal: AbortSignal): Board | null {
  const own = (board as { [STOPPED_BY]?: (signal: AbortSignal) => Board })[STOPPED_BY]
  return typeof own === 'function' ? own(signal) : null
}

/** `response`, with a body that errors with `signal`'s reason once it fires: a download whose body stalls ends too. */
function bounded(response: Response, signal: AbortSignal): Response {
  // An error's body is read at once, and the response is how the client knows a handle's own errors.
  if (!response.ok || !response.body) return response
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        controller.error(signal.reason)
        void reader.cancel(signal.reason).catch(() => {})
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    },
    async pull(controller) {
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        read = await reader.read()
      } catch (error) {
        // The signal's own error is out already; any other is the body's, and the caller gets it.
        if (!signal.aborted) controller.error(error)
        return
      }
      if (signal.aborted) return
      if (read.done) controller.close()
      else controller.enqueue(read.value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** `work`, or `signal`'s reason once it fires, whichever comes first. */
function until<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** How long a handle's live events wait for the next, in seconds, before asking again. */
const EVENTS_WAIT_S = 25

/** A profile's name, as the board takes one in `x-board-profile`. */
const SANDBOX_PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

/** An avatar the board takes: an https URL, or http on localhost. */
const avatarUrl = (value: string) => {
  const url = URL.parse(value)
  return url !== null && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
}

/** A board's name: 1 to 64 characters, no `/`. */
const BOARD_NAME = /^[^/]{1,64}$/
/** A team, by its ID or its slug. */
const TEAM = /^[^\s/]+$/

/** Whether `name` is a board's name, such as `security`, counted as Vercel's API counts it: trimmed and NFC-normalized. */
export const isBoardName = (name: string): boolean => BOARD_NAME.test(name.trim().normalize('NFC'))

/**
 * A board for this project, on `backend`: Vercel's board for the team by default, `local()` in this
 * process, or one of your own. What it returns is the handle: its
 * methods act as the board's caller, and `fetch` serves the protocol over HTTP. Create it once,
 * at module scope, or one per tenant for a host.
 */
export function createBoard(options: BoardOptions, runtime: Runtime): Board {
  if (options.name !== undefined && !isBoardName(options.name))
    throw new Error(`board: ${JSON.stringify(options.name)} isn't a board's name: one is 1 to 64 characters with no /, and another team's board takes its team apart, board({ team, name })`)
  if (options.team !== undefined && !TEAM.test(options.team)) throw new Error(`board: ${JSON.stringify(options.team)} isn't a team: pass its ID (team_…) or its slug`)
  if (options.ensure && options.name === undefined) throw new Error('board: ensure makes the board `name` names: pass name too')
  const backend = options.backend ?? runtime.backend(options.fetch)
  const policy = createPolicy(options, backend.keeps, runtime.serving, backend.trust ?? null)
  const watch = options.watch ?? {}
  const entries = options.sync ?? {}
  const state: BoardContext['state'] = { learned: null }
  /** Under the configured mount, so the router accepts the paths an in-process client builds. */
  const inProcess = `http://in-process.board${(options.basePath ?? '').replace(/\/+$/, '')}`

  /**
   * This board's own URL, where a board elsewhere wakes it: `url`, or on Vercel its production
   * domain (a preview's own URL there), and never a request's Host, which its sender chooses.
   */
  function ownUrl(): string | null {
    if (options.url) return options.url.replace(/\/+$/, '')
    const env = typeof process === 'undefined' ? undefined : process.env
    const domain = env?.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : env?.VERCEL_URL
    const base = options.basePath ?? state.learned
    return domain && base !== null ? `https://${domain}${base}`.replace(/\/+$/, '') : null
  }

  let loading: Promise<Serve> | null = null
  /** The board's pipeline, made once, when the board first serves, watches, syncs, or a handle calls it. */
  function server(): Promise<Serve> {
    loading ??= createServe(context)
    loading.catch(() => (loading = null))
    return loading
  }

  // `writes` counts a trigger's posts, which their IDs derive from: a handle `stoppedBy` makes counts on with the one it came from.
  function clientAs(caller: Caller | PlatformCaller, trigger: string | null, stop?: AbortSignal, writes = { made: 0 }): BoardClient {
    const inject = async (request: Request) => (await server()).inject(request, caller, trigger, writes)
    return createBoardClient({
      url: inProcess,
      token: 'in-process',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!stop) return inject(new Request(input, init))
        // The backend gets the signal, and the caller its answer when it fires, whether or not the backend heeds it.
        const signal = init?.signal ? AbortSignal.any([init.signal, stop]) : stop
        // Stopped already, nothing starts: a write queued behind a hung call never lands after its caller heard it failed.
        if (signal.aborted) throw signal.reason
        return bounded(await until(signal, inject(new Request(input, { ...init, signal }))), signal)
      }) as typeof fetch,
      ...(stop ? { storeFetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, stop]) : stop })) as typeof fetch } : {}),
    })
  }

  const serve = async (request: Request): Promise<Response> => (await server()).dispatch(request, null)

  /** How a sandbox reaches this board, where it keeps the board itself: at its own URL, with this deployment's credential. */
  async function ownReach({ profile, can, token }: SandboxInput): Promise<SandboxReach> {
    const url = ownUrl()
    if (url === null) throw new HttpError(400, 'no_url', "A sandbox reaches this board at its URL, and it doesn't know it yet.", { hint: 'Pass board({ url }).', origin: 'handle' })
    const credential = runtime.sandbox ? await runtime.sandbox(url, token) : token === undefined ? withoutToken(url) : { authorization: `Bearer ${token}` }
    return { url, headers: { ...credential, 'x-board-profile': formatProfileHeader(profile), 'x-board-can': can }, routes: PROTOCOL_ROUTES }
  }

  /** `can`'s header text, read as the board reads one: a 400 `invalid_scope` for one it doesn't. */
  function canOf(can: Can | string | undefined): string {
    try {
      return canHeader(can)
    } catch (error) {
      if (error instanceof InvalidCan) throw new BoardError('invalid_scope', error.message, 400)
      throw error
    }
  }

  /** What a handle narrowed to `held` (or nothing) may do once `can` narrows it too: never more than either. */
  const within = (held: string | undefined, can: string): string => (held === undefined ? can : canText(compileAccess(parseCan(held)).narrow(parseCan(can))))

  /** The `can` a handle as `caller` holds: what `as(profile, { can })` gave it. */
  const heldBy = (caller: Caller): string | undefined => ('self' in caller ? caller.can : undefined)

  /** The policy that hands this board to a sandbox, for a handle as `caller`. */
  async function sandboxPolicy(caller: Caller, options: SandboxPolicyOptions = {}): Promise<SandboxPolicy> {
    const own = 'profile' in caller ? caller.profile : null
    const named = options.profile ?? (own === null || own === undefined ? null : typeof own === 'string' ? { name: own } : own)
    if (named === null)
      throw new BoardError('invalid_profile', "A sandbox writes as a profile of this deployment, and this names none: the sandbox could send its own, and write as any.", 400, {
        hint: "Name one: sandboxPolicy({ profile: { name } }), or team.as('<name>').sandboxPolicy().",
      })
    if (!SANDBOX_PROFILE.test(named.name)) throw new BoardError('invalid_profile', `${named.name} isn't a profile's name: one starts with a letter and uses up to 32 letters, numbers, and hyphens.`, 400)
    if (named.avatar !== undefined && !avatarUrl(named.avatar)) throw new BoardError('invalid_profile', `${named.avatar} isn't an avatar: one is an https URL, or http on localhost.`, 400)
    // A narrowed handle hands a sandbox no more than it holds itself.
    const can = within(heldBy(caller), canOf(options.can))
    const input: SandboxInput = { profile: named, can, token: options.token }
    try {
      return boardPolicy(backend.sandbox ? await backend.sandbox(input) : await ownReach(input))
    } catch (error) {
      if (error instanceof HttpError) throw new BoardError(error.code, error.message, error.status, { ...(error.hint !== undefined ? { hint: error.hint } : {}), origin: error.origin })
      throw error
    }
  }

  /** A handle on `client`, which `as` gives other profiles of. */
  function handle(client: BoardClient, url: (() => string) | null, caller: Caller, trigger: string | null, stop: AbortSignal | undefined, writes: { made: number }): Board {
    const made = { ...client, fetch: serve, as: asFrom(caller, stop), sandboxPolicy: (options?: SandboxPolicyOptions) => sandboxPolicy(caller, options) } as Board
    if (url) Object.defineProperty(made, 'url', { get: url, enumerable: true })
    Object.defineProperty(made, STOPPED_BY, { value: (signal: AbortSignal) => handleOf(caller, trigger, signal, writes) })
    return made
  }

  /**
   * A handle through board(), as `caller`: a post's `id` is its own, derived under who it writes as,
   * so a retry posts once and no request can take it first. A verified caller's are a backend's,
   * derived already (a schedule's send's), so they go as they are.
   */
  function handleOf(caller: Caller, trigger: string | null, stop?: AbortSignal, writes = { made: 0 }): Board {
    const client = clientAs(caller, trigger, stop, writes)
    if ('identity' in caller) return handle({ ...client, events: (query, opts) => events(client, query, opts) }, () => ownUrl() ?? inProcess, caller, trigger, stop, writes)
    const via = caller.origin.via?.kind ?? 'client'
    const id = (given: string) => derivedId(`board-${via === 'watcher' ? 'watch' : via}`, caller.self ?? '', given)
    const owned = async <T extends { id?: string }>(input: string | T): Promise<string | T> =>
      typeof input === 'string' || input.id === undefined ? input : { ...input, id: await id(input.id) }
    return handle(
      {
        ...client,
        post: async (channel, input) => client.post(channel, await owned(input)),
        reply: async (re, input) => client.reply(re, await owned(input)),
        posted: async (given) => client.posted(await id(given)),
        // A task's new thread is a post: its `id` is this caller's own too.
        tasks: {
          ...client.tasks,
          create: (async (target: string | { re: string }, input?: string | NewTaskOptions | TaskOptions) =>
            typeof target === 'string' ? client.tasks.create(target, await owned(input as string | NewTaskOptions)) : client.tasks.create(target, input as TaskOptions | undefined)) as BoardClient['tasks']['create'],
          createMany: async (channel, tasks, opts = {}) => client.tasks.createMany(channel, tasks, opts.id !== undefined ? { id: await id(opts.id) } : opts),
        },
        // In-process, a request is this caller's whatever its headers say: another profile is another handle's.
        request: (path, init = {}) => {
          const { as: profile, ...rest } = init
          return profile !== undefined ? asFrom(caller, stop)(profile).request(path, rest) : client.request(path, rest)
        },
        events: (query, opts) => events(client, query, opts),
      },
      () => ownUrl() ?? inProcess,
      caller,
      trigger,
      stop,
      writes,
    )
  }

  const profileCaller = (profile: ProfileOption, can: string | undefined): SelfCaller => {
    const name = profile === null ? null : typeof profile === 'string' ? profile : profile.name
    return { self: name, profile, ...(can !== undefined ? { can } : {}), origin: { via: { kind: 'client', name } } }
  }

  /**
   * `as()` on a handle as `caller`: another profile, held to what that handle holds, and to `can`
   * when it's given, and stopped by what stops that handle.
   */
  const asFrom =
    (caller: Caller, stop?: AbortSignal) =>
    (profile: ProfileOption, options: AsOptions = {}): Board => {
      const held = heldBy(caller)
      const can = options.can === undefined ? held : within(held, canOf(options.can))
      return handleOf(profileCaller(profile, can), null, stop)
    }

  const context: BoardContext = { options, backend, runtime, policy, state, ownUrl, clientAs, handleOf }

  const subscriptions: Record<string, Subscription> = Object.fromEntries(
    Object.entries(watch).map(([id, watcher]) => [id, { kind: 'tail', tail: watcher.tail }]),
  )
  if (Object.keys(entries).length > 0) subscriptions[SYNC] = { kind: 'sync' }
  /** This board's sync entries, as its sync and discovery see them. */
  const ownEntries: SyncEntry[] = Object.entries(entries).map(([key, entry]) => ({ key, platform: entry.platform }))
  const binding: BoardBinding = {
    name: options.name ?? null,
    team: options.team ?? null,
    ensure: options.ensure ?? true,
    subscriptions,
    run: async (id, event, meta) => (await server()).run(id, event, meta),
    receive: async (key, item, meta) => (await server()).receive(key, item, meta),
    pull: async () => (ownEntries.length > 0 ? (await server()).pull() : 0),
    sync: ownEntries,
    readSource: async (key, target, limit, after) => (await server()).readSource(key, target, limit, after),
    joinSource: async (key, target) => (await server()).joinSource(key, target),
    locate: (url) => {
      const read = new Map<string, { platform: string; thread: string; message: string | null }>()
      for (const entry of Object.values(entries)) {
        const found = entry.locate(url)
        if (found) read.set(JSON.stringify([entry.platform, found.thread, found.message]), { platform: entry.platform, ...found })
      }
      return [...read.values()]
    },
    linkOf: async (key, thread, message) => {
      const entry = Object.hasOwn(entries, key) ? entries[key] : undefined
      if (!entry || !thread.startsWith(`${key}:`)) return null
      return entry.url(thread.slice(key.length + 1), message).catch(() => null)
    },
    typing: async (messages, status) => (await server()).typing(messages, status),
    accessNow: (principal, grants) => policy.accessNow(principal, grants),
    explain: (principal, channel) => policy.explain(principal, channel),
    project: () => policy.project(),
    logins: policy.logins,
    handle: (caller) => handleOf(caller, null),
    url: ownUrl,
  }
  backend.bind(binding)

  return handleOf({ self: null, origin: { via: { kind: 'client', name: null } } }, null)
}

/**
 * Live events for a handle, from the backend's long-poll: each page from the last cursor it saw,
 * waiting for the next. It backs off after a failure, up to 30 seconds; a 4xx throws. `onState`
 * hears `live` when a poll is answered and `retrying` when one failed. The first poll, and the
 * first after a failure, ask without waiting, so it's `live` as soon as the board answers, not a
 * quiet board's whole wait later.
 */
async function* events(
  client: BoardClient,
  query: Parameters<BoardClient['events']>[0] = {},
  opts: EventsOptions = {},
): AsyncGenerator<BoardEventView> {
  // The feed's newest events (`last`) are its first read, which takes no wait: it goes on from their cursor.
  const { last, ...rest } = query
  let after = query.after
  let failures = 0
  /** Whether the board has answered since the feed started, or since it last failed. */
  let answered = false
  const state = eventsState(opts.onState)
  while (!opts.signal?.aborted) {
    let page: Awaited<ReturnType<BoardClient['poll']>>
    try {
      page = await client.poll((after === undefined && last !== undefined ? { ...rest, last } : { ...rest, ...(after !== undefined ? { after } : {}), wait: answered ? EVENTS_WAIT_S : 0 }) as Parameters<BoardClient['poll']>[0], opts.signal)
    } catch (error) {
      if (opts.signal?.aborted) return
      // A refusal isn't an outage: what the board doesn't do (501) is said, as what the caller got wrong is, and not retried.
      if (error instanceof BoardError && (error.status === 501 || (error.status >= 400 && error.status < 500))) throw error
      answered = false
      state.failed()
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** failures++)))
      continue
    }
    failures = 0
    answered = true
    state.answered()
    for (const event of page.events) {
      yield event
      if (opts.signal?.aborted) return
    }
    after = page.cursor
  }
}
