import { everyChannel } from '../client/channels.ts'
import { INBOX_EVENT_ID_MAX, type Explanation, type GrantView, type Me, type MessageView, type RegistrationView } from '../api/routes.ts'
import { BoardError, type ExplainPrincipal, type TaskInBatch, type TaskOptions } from '../client/client.ts'
import { block } from '../contract/blocks.ts'
import { canonical } from '../contract/data-schemas.ts'
import { canText, compileAccess, type Permission } from '../server/access.ts'
import type { Board } from '../server/board.ts'

/**
 * Checks that a board speaks the protocol, through a handle on it (`conformance(board())`), as
 * `vb` and agents use it: every board answers all of it. A board may keep no schedules, tasks, or
 * files, or no index to find threads by what their messages say or who wrote them, and says so with a
 * 501, which the kit reports as not kept here. It writes to one channel
 * (`conformance` by default), and for the tasks checks that need two, to `tasks` under it, keeps
 * every post on the board, and deletes what it posted. The one
 * schema it registers, `conformance@1`, stays: a schema version is never removed.
 */

/** What a check is about, for the report's headings. */
export type CheckGroup = 'core' | 'paging' | 'search' | 'schedules' | 'tasks' | 'grants' | 'schemas' | 'attachments' | 'watchers' | 'sync'

export type CheckResult = {
  group: CheckGroup
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /** Why it failed, or why it was skipped: `not kept here: …` for what the board answers 501 to. */
  detail?: string
}

export type ConformanceReport = {
  url: string
  checks: CheckResult[]
  /** Every check passed or was skipped. */
  ok: boolean
}

export type ConformanceOptions = {
  /** Where it posts. Default `conformance`. */
  channel?: string
  /**
   * The same board, with this run's credential and an `x-board-can` header that narrows it to
   * `can` (`conformance=read`), as a proxy holding the credential sends it: the checks of a
   * narrowed caller call it so. Without it, they're skipped.
   */
  withCan?: (can: string) => Board
  /**
   * The same board, with this run's credential and `headers` on every request, as a client or a proxy
   * holding the credential sends them: the checks of who writes call it so, with an
   * `x-board-profile` that carries an avatar and the headers that one replaced. Without it, they're
   * skipped, and it stands in for `withCan` when that's left out.
   */
  withHeaders?: (headers: Record<string, string>) => Board
  /**
   * Whom the grants checks name. A board that verifies tokens itself (`vb serve`) takes the made-up
   * IDs they use without it; one that looks names up, as Vercel's API does, needs real ones on its
   * team, or skips the checks that name them: a `project` (its name or ID), a GitHub `repository`
   * no grant names, a `viewer` (a person's email or ID whose team role is viewer), to check
   * that a role caps what grants give, and an `app` installed on the board's team (its slug or
   * client ID), which a local board has none of. Checks that grant to someone besides the project
   * name the app when there's one, and the repository otherwise. None may be the run's own: it
   * throws before it writes.
   */
  principals?: { project?: string; repository?: string; viewer?: string; app?: string }
}

class Mismatch extends Error {}

const show = (value: unknown) => JSON.stringify(value) ?? String(value)

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Mismatch(message)
}

function same(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Mismatch(`${what}: expected ${show(expected)}, got ${show(actual)}`)
}

async function rejects(attempt: Promise<unknown>, status: number, code: string, what: string) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof BoardError && error.status === status && error.code === code) return
    throw new Mismatch(`${what}: expected ${status} ${code}, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
  throw new Mismatch(`${what}: expected ${status} ${code}, and it succeeded`)
}

/** That `attempt` is refused with `status`, whatever code the board gives it. */
async function refused(attempt: Promise<unknown>, status: number, what: string) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof BoardError && error.status === status) return
    throw new Mismatch(`${what}: expected ${status}, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
  throw new Mismatch(`${what}: expected ${status}, and it succeeded`)
}

const NO_CAN = "this run can't call the board with an x-board-can header"
const NO_HEADERS = "this run can't call the board with headers of its own"
const UNPAGED = "this board doesn't page threads back: its pages have no older"

/** The avatar the checks of who writes give their profile. */
const AVATAR = 'https://example.com/conformance.png'

/** A post by `poster`, which sends `header`, read back as the run sees it: it lands, and is deleted when the run ends. */
async function postedWith(ctx: Context, poster: Board, header: string) {
  const posted = await poster.post(ctx.channel, { text: `conformance: with ${header}`, labels: ctx.labels, noSync: true }).catch((error: unknown) => {
    throw new Mismatch(`a post with ${header}, which released clients still send: expected it to land, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  })
  ctx.posted.push(posted.id)
  return (await ctx.board.thread(posted.id)).message
}

/** That a view's `by` names who wrote it as the protocol has it: an actor, a principal, and a profile, and no session. */
function noSession(by: unknown, what: string) {
  check(typeof by === 'object' && by !== null, `${what} should have a by, got ${show(by)}`)
  check(!('session' in by), `${what} should carry no session, got ${show(by)}`)
}

/**
 * That `attempt`, by a caller narrowed with `x-board-can`, is refused as one: 403 `forbidden`.
 * Vercel's API's refusal of a person's watchers goes on as it is, for the run to skip.
 */
async function narrowedOut(attempt: Promise<unknown>, what: string) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof BoardError && error.code === 'watchers_need_project') throw error
    if (error instanceof BoardError && error.status === 403 && error.code === 'forbidden') return
    throw new Mismatch(`${what}, by a caller narrowed with x-board-can: expected 403 forbidden, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
  throw new Mismatch(`${what}, by a caller narrowed with x-board-can: expected 403 forbidden, and it succeeded`)
}

/** Where a registration is woken, to put back after a check replaces it: its path (and branch) on a board that wakes by path, or nowhere. */
function wokenAt(registered: RegistrationView | undefined): { path?: undefined } | { path: string; branch?: string } {
  if (!registered?.path) return {}
  return { path: registered.path, ...(registered.branch ? { branch: registered.branch } : {}) }
}

/** An ID or cursor as the protocol shapes them: a string of 1 to 128 characters. */
function isRef(value: unknown, what: string) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 128, `${what} should be a string of 1 to 128 characters, got ${show(value)}`)
}

type Context = {
  board: Board
  channel: string
  /** Every post carries it, so reads see this run's messages only. */
  labels: { conformance: string }
  /** The board's position before this run wrote anything. */
  start: string
  me: Me
  root?: MessageView
  reply?: MessageView
  posted: string[]
  withCan?: (can: string) => Board
  withHeaders?: (headers: Record<string, string>) => Board
  principals: Principals
  /** The board's own Vercel team, as its discovery names it. */
  team: string | null
}

type Check = { group: CheckResult['group']; name: string; run: (ctx: Context) => Promise<void | string> }

/**
 * The groups a board may keep none of, saying so with a 501: a board without a scheduler answers
 * `no_scheduler`, and without a blob store `no_files`; one that keeps no tasks answers `no_tasks`,
 * a backend of one's own that keeps no grants `no_grants`, and one that keeps no schemas
 * `no_schemas`. `search` is finding threads by what their messages say, and reading every channel
 * under a pattern at once: a board with no index for either, as Vercel's has none, answers
 * `not_supported`. A board that's meant to keep something and doesn't yet answers otherwise, and fails.
 */
const OPTIONAL = new Set<CheckGroup>(['search', 'schedules', 'tasks', 'grants', 'schemas', 'attachments'])

const needRoot = (ctx: Context) => {
  check(ctx.root && ctx.reply, "posting failed, so there's nothing to read")
  return { root: ctx.root, reply: ctx.reply }
}

/**
 * Who the grants checks name: `principals`' own, or made-up IDs, which a board that verifies tokens
 * itself takes. A grant naming them lets nobody in.
 */
type Principals = { project: string; repository: string; viewer: string | null; app: string | null }

/** A check's project, in its environments. */
const projectFor = (ctx: Context, environments = ['preview']) => ({ kind: 'project' as const, project: ctx.principals.project, environments })

/**
 * The subtree every grant the grants checks make sits in, `conformance/grants/`, and every channel
 * they ask about: the same for every run, so a run leaves no channel behind, and no grant reaches
 * outside it. Two runs on one board at once see each other's grants there.
 */
const subtreeOf = (ctx: Context) => `${ctx.channel}/grants/`

/** The check's grant: that project may post in the subtree's `ci/`. */
const grantFor = (ctx: Context) => ({ principals: [projectFor(ctx)], can: { [`${subtreeOf(ctx)}ci/`]: ['post'] } }) as const

/**
 * Whom the checks that grant to someone besides the project name: the app the run was given, or
 * else the repository, which a board that takes no GitHub principal in a grant refuses.
 */
const granteeOf = (ctx: Context) =>
  ctx.principals.app !== null ? ({ kind: 'app', app: ctx.principals.app } as const) : ({ kind: 'github', repository: ctx.principals.repository } as const)

/** A check that can't run here, and why: it's skipped, not failed. */
class Skip extends Error {}

/** A board that looks names up and has none for one a check named: what to pass instead. */
function unnamed(error: unknown): Skip | null {
  if (!(error instanceof BoardError) || error.status !== 400 || !error.code.endsWith('_not_found')) return null
  return new Skip(`this board looks names up and found none for one the check named (${error.message}): pass principals that are real on its team`)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type GrantInput = Parameters<Board['createGrant']>[0]

/** What a grants check makes things with: each is revoked when it ends, whatever happens. */
type Grants = {
  /** Makes a grant, as this run or as `by`. The first this run makes tells whether it may change grants here at all: a 403 skips the check. */
  make(input: GrantInput, by?: Board, options?: Parameters<Board['createGrant']>[1]): Promise<GrantView>
  /** Makes several in one write, as this run, once it has made one alone. An `everyone` grant among them is revoked before the others, which may be keeping this run in. */
  makeAll(inputs: readonly GrantInput[]): Promise<GrantView[]>
  /** The principal a grant names this run by: its user, its project in its environment, or its app. Null for the board's own code, which no grant narrows; a skip for a run no grant could name. */
  self(): NonNullable<GrantInput['principals'][number]> | null
  /** That `by` is refused a grant, with a 403: one a board wrongly makes is revoked too. */
  deny(by: Board, input: GrantInput, what: string): Promise<void>
  /** This run, narrowed with `x-board-can` to `can`: a run that can't send one skips the check. */
  narrow(can: Record<string, 'all' | readonly Permission[]>): Board
  /**
   * A grant that keeps this run in `pattern` with `manage`, so it can lift an `everyone` grant
   * there, which would narrow it too: its user, or its project in its environment.
   */
  keep(pattern: string): Promise<void>
}

/**
 * Runs `check` with what it makes grants with, and revokes them all afterwards, the
 * newest grant first, so one that closes a pattern goes while the one keeping this run in is there.
 * A revoke that fails fails the check: what it made would stay on the board.
 */
async function withGrants(ctx: Context, check: (grants: Grants) => Promise<void | string>): Promise<void | string> {
  const made: string[] = []
  const grants: Grants = {
    async make(input, by, options) {
      try {
        const { grant } = await (by ?? ctx.board).createGrant(input, options)
        made.push(grant.id)
        return grant
      } catch (error) {
        if (!by && made.length === 0 && error instanceof BoardError && error.status === 403) throw new Skip("this token can't change the board's grants")
        throw unnamed(error) ?? error
      }
    },
    async makeAll(inputs) {
      try {
        const { grants: all } = await ctx.board.createGrants(inputs)
        // Revoked newest first: everyone's go before the grants that may be keeping this run in.
        const closes = (grant: GrantView) => grant.principals.some((principal) => principal.kind === 'everyone')
        made.push(...all.filter((grant) => !closes(grant)).map((grant) => grant.id), ...all.filter(closes).map((grant) => grant.id))
        return all
      } catch (error) {
        throw unnamed(error) ?? error
      }
    },
    self() {
      const [source, kind, id, environment] = ctx.me.principal.split(':')
      if (source === 'board') return null
      if (ctx.me.kind === 'person') return { kind: 'user', userId: ctx.me.principal.split(':').slice(2).join(':') }
      if (kind === 'project' && id && environment) return { kind: 'project', project: id, environments: [environment] }
      if (kind === 'app' && id) return { kind: 'app', app: id }
      throw new Skip("closing a pattern to everyone would close it to this run too, which no grant could keep in: it's neither a person, a project, nor an app")
    },
    async deny(by, input, what) {
      try {
        const { grant } = await by.createGrant(input)
        made.push(grant.id)
      } catch (error) {
        if (error instanceof BoardError && error.status === 403) return
        // A board that takes none of these principals skips the check, as below.
        if (error instanceof BoardError && error.code === 'unsupported_principal') throw error
        throw unnamed(error) ?? new Mismatch(`${what}: expected 403, got ${error instanceof BoardError ? `${error.status} ${error.code}` : messageOf(error)}`)
      }
      throw new Mismatch(`${what}: expected 403, and it made the grant`)
    },
    narrow(can) {
      if (!ctx.withCan) throw new Skip(NO_CAN)
      return ctx.withCan(canText(compileAccess(can)))
    },
    async keep(pattern) {
      const self = grants.self()
      if (self) await grants.make({ principals: [self], can: { [pattern]: 'all' } })
    },
  }
  let result: void | string = undefined
  let failure: unknown = null
  try {
    result = await check(grants)
  } catch (error) {
    if (error instanceof Skip) result = error.message
    else failure = error
  }
  const left: string[] = []
  for (const id of made.reverse())
    await ctx.board.revokeGrant(id).catch((error: unknown) => {
      left.push(`${id} (${messageOf(error)})`)
    })
  if (left.length > 0) throw new Mismatch(`${failure ? `${messageOf(failure)}; and it ` : ''}couldn't revoke what it made: ${left.join(', ')}`)
  if (failure) throw failure
  return result
}

/** What decides `channel` for `principal` (the caller, without one), or a skip where the board can't find it by name. */
async function explain(ctx: Context, channel: string, principal?: ExplainPrincipal): Promise<Explanation> {
  try {
    return await ctx.board.explain(channel, principal)
  } catch (error) {
    throw unnamed(error) ?? error
  }
}

const sortedOf = (values: readonly string[] | undefined) => [...(values ?? [])].sort()

/** That `actual` shows as `expected` does: a value compared as JSON, shown once when it isn't. */
function alike(actual: unknown, expected: unknown, what: string) {
  if (show(actual) !== show(expected)) throw new Mismatch(`${what}: expected ${show(expected)}, got ${show(actual)}`)
}

/**
 * The schema the schemas checks register: the same on every run, since a version never changes and
 * is never removed, so a board holds one however often it's checked. A change to it is a new
 * version here, never an edit: a board checked before would refuse this one as another definition.
 * It names every property it requires and gives each keyword its type, as the strictest board asks.
 */
const SCHEMA = {
  name: 'conformance',
  version: 1,
  description: 'What the conformance kit registers, once on every board it checks.',
  schema: {
    type: 'object',
    required: ['run', 'outcome'],
    additionalProperties: false,
    properties: {
      run: { type: 'string', minLength: 1, maxLength: 64 },
      outcome: { enum: ['passed', 'failed'] },
      checks: { type: 'array', maxItems: 500, items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, skipped: { type: 'boolean' } } } },
    },
  },
} as const

/** `SCHEMA`'s definition, saying the same with its keys the other way around. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)])) : value

/** Registers `SCHEMA`, or says why this run can't: a caller without manage at `*` is refused, and the check skipped. */
async function register(ctx: Context): Promise<{ made: Awaited<ReturnType<Board['createSchema']>> } | { skip: string }> {
  try {
    return { made: await ctx.board.createSchema(SCHEMA) }
  } catch (error) {
    if (error instanceof BoardError && error.status === 403) return { skip: "this token can't register schemas" }
    throw error
  }
}

/** The sync key the sync checks register, a platform of their own, so nothing reaches a real one. */
const SYNC_KEY = 'conformance'

/**
 * Registers a sync on `SYNC_KEY` for a check, and says where to put the token's registration back
 * after: or why it can't, since registering replaces the token's watchers.
 */
async function registerSync(ctx: Context): Promise<{ where: ReturnType<typeof wokenAt> } | { skip: string }> {
  const registered = (await ctx.board.watchers()).find((registration) => registration.owner === ctx.me.principal)
  if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
    return { skip: 'this token has watchers or a sync registered here, which registering would replace' }
  const where = wokenAt(registered)
  try {
    await ctx.board.register({ watch: {}, sync: [{ key: SYNC_KEY, platform: SYNC_KEY }] })
  } catch (error) {
    if (error instanceof BoardError && error.status === 403) return { skip: "this token can't register a sync here" }
    throw error
  }
  return { where }
}

async function post(ctx: Context, text: string, extra: { id?: string; attachments?: string[] } = {}) {
  const message = await ctx.board.post(ctx.channel, { text, labels: ctx.labels, noSync: true, ...extra })
  ctx.posted.push(message.id)
  return message
}

async function reply(ctx: Context, re: string, text: string, extra: { after?: string; id?: string } = {}) {
  const message = await ctx.board.reply(re, { text, noSync: true, ...extra })
  ctx.posted.push(message.id)
  return message
}

/** A task of this run's, in a thread of its own that stays on the board: the run deletes its root at the end, which cancels it. */
async function task(ctx: Context, text: string, options: TaskOptions & { labels?: Record<string, string>; attachments?: string[] } = {}) {
  const { labels, ...rest } = options
  const made = await ctx.board.tasks.create(ctx.channel, { text, labels: { ...ctx.labels, ...labels }, noSync: true, ...rest })
  ctx.posted.push(made.task.id)
  return made
}

/** Several tasks of this run's, made in one write: the run deletes their roots at the end, as it does a task's. */
async function taskBatch(ctx: Context, tasks: TaskInBatch[], opts: { id?: string } = {}) {
  const made = await ctx.board.tasks.createMany(ctx.channel, tasks.map((one) => ({ ...one, labels: ctx.labels, noSync: true })), opts)
  ctx.posted.push(...made.map((root) => root.id))
  return made
}

/**
 * The second channel the tasks checks make tasks in, `conformance/tasks`: the same for every run, so
 * a run leaves no channel behind.
 */
const besideOf = (ctx: Context) => `${ctx.channel}/tasks`

/** A task of this run's in that channel, or null when the run may not post there. */
async function taskBeside(ctx: Context, text: string, options: TaskOptions = {}) {
  try {
    const made = await ctx.board.tasks.create(besideOf(ctx), { text, labels: ctx.labels, noSync: true, ...options })
    ctx.posted.push(made.task.id)
    return made
  } catch (error) {
    if (error instanceof BoardError && error.status === 403) return null
    throw error
  }
}

/** A task's state, as its thread reads now. */
const taskState = async (ctx: Context, id: string) => (await ctx.board.thread(id)).message.task?.state

/** Waits up to a few seconds for what a board may derive a moment late, a task becoming ready, say. */
async function soon(found: () => Promise<boolean>, what: string) {
  for (const deadline = Date.now() + 10_000; ; ) {
    if (await found()) return
    if (Date.now() >= deadline) throw new Mismatch(`${what}, within a few seconds`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** That each claim that lost a race was told the task is claimed. */
function lostRace(racing: PromiseSettledResult<unknown>[]) {
  for (const result of racing) {
    if (result.status === 'fulfilled') continue
    const error = result.reason as unknown
    check(error instanceof BoardError && error.status === 409 && error.code === 'task_claimed', `a claim that lost the race should be 409 task_claimed, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
}

const CHECKS: Check[] = [
  {
    group: 'core',
    name: 'posts a message, and reads it back by its ID',
    run: async (ctx) => {
      const root = await post(ctx, 'conformance: a root')
      isRef(root.id, "a message's id")
      check(typeof root.version === 'number', `a message's version should be a number, got ${show(root.version)}`)
      const thread = await ctx.board.thread(root.id)
      same(thread.message.id, root.id, 'the thread read by that id')
      same(thread.message.text, 'conformance: a root', 'its text')
      ctx.root = root
      const reply = await ctx.board.reply(root.id, { text: 'conformance: a reply', noSync: true })
      ctx.posted.push(reply.id)
      ctx.reply = reply
    },
  },
  {
    group: 'core',
    name: "puts a reply in its root's thread",
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      same(reply.re, root.id, "the reply's re")
      const thread = await ctx.board.thread(root.id)
      check(thread.replies.some((m) => m.id === reply.id), `the thread's replies should include ${reply.id}`)
    },
  },
  {
    group: 'core',
    name: "replies after a message only while it's the thread's newest, one of any that race",
    run: async (ctx) => {
      // A thread of its own, so the other checks' counts stay as they are.
      const root = await post(ctx, 'conformance: a thread to reply after')
      const first = await reply(ctx, root.id, 'conformance: after the root', { after: root.id })
      await rejects(reply(ctx, root.id, 'conformance: late', { after: root.id }), 409, 'newer_message', 'a reply after the root, once another came after it')
      same((await ctx.board.thread(root.id)).replies.length, 1, 'the replies after a refused one')
      // One that's since been deleted came after it all the same.
      const deleted = await reply(ctx, root.id, 'conformance: deleted', { after: first.id })
      await ctx.board.delete(deleted.id)
      await rejects(reply(ctx, root.id, 'conformance: after a deleted one', { after: first.id }), 409, 'newer_message', 'a reply after a message a deleted one came after')
      // Racing after the same message, one lands and the rest are refused.
      const racing = await Promise.allSettled([1, 2, 3].map((n) => reply(ctx, root.id, `conformance: racing ${n}`, { after: deleted.id })))
      const landed = racing.filter((result) => result.status === 'fulfilled')
      same(landed.length, 1, 'the replies that landed of three racing after the same message')
      for (const result of racing) {
        if (result.status === 'fulfilled') continue
        const error = result.reason as unknown
        check(error instanceof BoardError && error.status === 409 && error.code === 'newer_message', `a reply that lost the race should be 409 newer_message, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      same((await ctx.board.thread(root.id)).replies.length, 3, 'the replies after the race, a deleted one included')
    },
  },
  {
    group: 'core',
    name: 'posts once for a client ID, however many times it is sent',
    run: async (ctx) => {
      const id = `conformance-${ctx.labels.conformance}`
      const first = await post(ctx, 'conformance: once', { id })
      const again = await post(ctx, 'conformance: once', { id })
      same(again.id, first.id, 'the second post with the same client id')
      same((await ctx.board.posted(id)).id, first.id, 'the post found by its client id')
      await rejects(ctx.board.posted(`${id}-never`), 404, 'post_not_found', 'a client id nothing was posted with')
    },
  },
  {
    group: 'core',
    name: 'raises the version with each edit, reaction, and label',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const version = async () => (await ctx.board.thread(root.id)).message
      let before = await version()
      for (const [what, change] of [
        ['an edit', () => ctx.board.edit(root.id, 'conformance: an edited root')],
        ['a reaction', () => ctx.board.react(root.id, 'eyes')],
        ['a label', () => ctx.board.label(root.id, { set: { state: 'open' } })],
      ] as const) {
        await change()
        const after = await version()
        check(after.version > before.version, `${what} should raise the version past ${before.version}, got ${after.version}`)
        before = after
      }
      same(before.text, 'conformance: an edited root', 'the edited text')
      check(before.editedAt !== null, 'an edited message should have editedAt')
      check(before.reactions.eyes?.includes(ctx.me.actor), `reactions.eyes should include ${ctx.me.actor}, got ${show(before.reactions)}`)
      same(before.labels.state, 'open', 'the label set')
      await ctx.board.label(root.id, { unset: ['state'] })
      same((await version()).labels.state, undefined, 'the label unset')
    },
  },
  {
    group: 'core',
    name: 'labels a message only while its labels are as the write says, one of any that race',
    run: async (ctx) => {
      // A message of its own, so the other checks' labels stay as they are.
      const message = await post(ctx, 'conformance: a message to claim')
      const labels = async () => (await ctx.board.thread(message.id)).message.labels
      // Three claim it at once, where no one has: one lands.
      const racing = await Promise.allSettled([1, 2, 3].map((n) => ctx.board.label(message.id, { set: { owner: `agent-${n}` }, if: { owner: null } })))
      const landed = racing.flatMap((result, n) => (result.status === 'fulfilled' ? [`agent-${n + 1}`] : []))
      same(landed.length, 1, 'the claims that landed of three racing where no one had one')
      for (const result of racing) {
        if (result.status === 'fulfilled') continue
        const error = result.reason as unknown
        check(error instanceof BoardError && error.status === 409 && error.code === 'label_conflict', `a claim that lost the race should be 409 label_conflict, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      same((await labels()).owner, landed[0], 'the owner, after the race')
      // From a value it doesn't have, nothing changes.
      await rejects(ctx.board.label(message.id, { set: { owner: 'someone' }, if: { owner: 'no-one' } }), 409, 'label_conflict', "a label write from a value the label doesn't have")
      same((await labels()).owner, landed[0], 'the owner, after a write from the wrong value')
      // From the one it has, it lands.
      await ctx.board.label(message.id, { unset: ['owner'], if: { owner: landed[0]! } })
      same((await labels()).owner, undefined, 'the owner, released from the value it had')
    },
  },
  {
    group: 'core',
    name: 'edits and deletes a message only at the revision it was read at, which only edits and deletes change',
    run: async (ctx) => {
      // A message of its own, so the other checks' text stays as it is.
      const message = await post(ctx, 'conformance: a message to edit')
      const read = async () => (await ctx.board.thread(message.id)).message
      const first = (await read()).revision
      check(typeof first === 'number', `a message's revision should be a number, got ${show(first)}`)
      await ctx.board.react(message.id, 'eyes')
      await ctx.board.label(message.id, { set: { state: 'open' } })
      same((await read()).revision, first, 'the revision after a reaction and a label')
      await ctx.board.edit(message.id, 'conformance: edited', { revision: first })
      const second = (await read()).revision
      check(second !== first, `an edit should change the revision from ${first}`)
      await rejects(ctx.board.edit(message.id, 'conformance: stale', { revision: first }), 409, 'revision_conflict', 'an edit at a revision an edit came after')
      await rejects(ctx.board.delete(message.id, { revision: first }), 409, 'revision_conflict', 'a delete at a revision an edit came after')
      const after = await read()
      check(after.text === 'conformance: edited' && !after.deleted, `refused writes should leave it as it was, got ${show({ text: after.text, deleted: after.deleted })}`)
      // Racing at the same revision, one lands and the rest are refused.
      const racing = await Promise.allSettled([1, 2, 3].map((n) => ctx.board.edit(message.id, `conformance: racing ${n}`, { revision: second })))
      same(racing.filter((result) => result.status === 'fulfilled').length, 1, 'the edits that landed of three racing at the same revision')
      for (const result of racing) {
        if (result.status === 'fulfilled') continue
        const error = result.reason as unknown
        check(error instanceof BoardError && error.status === 409 && error.code === 'revision_conflict', `an edit that lost the race should be 409 revision_conflict, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      const last = (await read()).revision
      await ctx.board.delete(message.id, { revision: last })
      check((await read()).deleted, 'a delete at the revision it has should delete it')
      // Read before the delete, an edit learns it changed since, not that it's gone.
      await rejects(ctx.board.edit(message.id, 'conformance: too late', { revision: last }), 409, 'revision_conflict', 'an edit at a revision a delete came after')
    },
  },
  {
    group: 'core',
    name: "reads one channel's messages after a cursor of its own, oldest first, and on from where it stopped",
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const channel = ctx.board.channel(ctx.channel)
      const page = await channel.messages({ after: ctx.start, limit: 500 })
      isRef(page.cursor, "a read's cursor")
      const ids = page.messages.map((m) => m.id)
      check(ids.indexOf(root.id) !== -1 && ids.indexOf(root.id) < ids.indexOf(reply.id), `the root should come before its reply, got ${show(ids)}`)
      check(page.messages.every((m) => m.channel === ctx.channel), `a channel's messages should all be in it, got ${show([...new Set(page.messages.map((m) => m.channel))])}`)
      const one = await channel.messages({ after: ctx.start, limit: 1 })
      same(one.messages.length, 1, 'how many messages a read with a limit of 1 lists')
      const rest = await channel.messages({ after: one.cursor, limit: 500 })
      const twice = rest.messages.filter((m) => one.messages.some((first) => first.id === m.id))
      check(twice.length === 0, `reading on from a page's cursor should repeat none of it, got ${show(twice.map((m) => m.id))} again`)
      const all = [...one.messages, ...rest.messages].map((m) => m.id)
      check(all.includes(root.id) && all.includes(reply.id), `reading on from a page's cursor should reach what came after it, got ${show(all)}`)
    },
  },
  {
    group: 'core',
    name: 'lists channels a page at a time, and the ones under a prefix',
    run: async (ctx) => {
      const paths = (channels: { path: string }[]) => channels.map((channel) => channel.path)
      const under = paths(await everyChannel(ctx.board, ctx.channel))
      check(under.includes(ctx.channel) && under.every((path) => path.startsWith(ctx.channel)), `the channels under ${ctx.channel} should be it and the ones that start with it, got ${show(under)}`)
      const seen: string[] = []
      let after: string | undefined
      do {
        const page = await ctx.board.channels({ prefix: ctx.channel, limit: 1, ...(after !== undefined ? { after } : {}) })
        check(page.channels.length <= 1, `a list with a limit of 1 should answer 1 channel at most, got ${show(paths(page.channels))}`)
        seen.push(...paths(page.channels))
        after = page.next ?? undefined
      } while (after !== undefined && seen.length <= under.length)
      same(show([...seen].sort()), show([...under].sort()), 'the channels under a prefix, read a page of 1 at a time')
    },
  },
  {
    group: 'core',
    name: "reads a thread's replies after one of its messages, and as many of its newest as it's asked for",
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const ids = (read: { message: MessageView; replies: MessageView[] }) => [read.message.id, ...read.replies.map((m) => m.id)]
      const whole = ids(await ctx.board.thread(root.id))
      const after = ids(await ctx.board.thread(root.id, { after: reply.id }))
      same(show(after), show([root.id, ...whole.slice(whole.indexOf(reply.id) + 1)]), 'a thread read after one of its replies: its root, and the replies after that one')
      const first = ids(await ctx.board.thread(reply.id, { after: root.id, limit: 1 }))
      same(show(first), show(whole.slice(0, 2)), 'a thread read for the first reply after its root')
      const newest = ids(await ctx.board.thread(root.id, { limit: 1 }))
      same(show(newest), show([root.id, whole.at(-1)]), 'a thread read for its newest reply')
    },
  },
  {
    group: 'core',
    name: "reads one channel's newest messages, as many as it's asked for",
    run: async (ctx) => {
      needRoot(ctx)
      const latest = await post(ctx, 'conformance: the newest message of the channel, for now')
      const page = await ctx.board.channel(ctx.channel).messages({ limit: 2 })
      check(page.messages.length <= 2, `a read with a limit of 2 should list 2 at most, got ${page.messages.length}`)
      // Another run may post here too: this one's newest is among the newest, or after them.
      const after = await ctx.board.channel(ctx.channel).messages({ after: page.cursor, limit: 500 })
      check([...page.messages, ...after.messages].some((m) => m.id === latest.id), `the newest messages, and what came after them, should include ${latest.id}`)
    },
  },
  {
    group: 'core',
    name: 'lists threads, each with its reply count and latest reply',
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const { threads } = await ctx.board.threads({ channel: ctx.channel, label: ctx.labels })
      const found = threads.find((t) => t.message.id === root.id)
      check(found, `the threads should include ${root.id}`)
      same(found.replies, 1, 'its reply count')
      same(found.last?.id, reply.id, 'its latest reply')
    },
  },
  {
    group: 'paging',
    name: "pages back through a channel's threads by their `older`, each thread once",
    run: async (ctx) => {
      const posted: string[] = []
      for (const n of [1, 2, 3]) posted.push((await post(ctx, `conformance: thread ${n} of 3 to page through`)).id)
      const first = await ctx.board.threads({ channel: ctx.channel, limit: 2 })
      if (!('older' in first)) return UNPAGED
      check(typeof first.older === 'string', `a first page of 2, with 3 threads or more, should have an older, got ${show(first.older)}`)
      const seen = first.threads.map((t) => t.message.id)
      for (let older: string | null | undefined = first.older; older !== null; ) {
        check(typeof older === 'string', `every page should have an older, a string or null, got ${show(older)}`)
        const page = await ctx.board.threads({ channel: ctx.channel, before: older, limit: 50 })
        seen.unshift(...page.threads.map((t) => t.message.id))
        older = page.older
      }
      const twice = seen.filter((id, i) => seen.indexOf(id) !== i)
      check(twice.length === 0, `paging back should list each thread once, got ${show([...new Set(twice)])} again`)
      for (const id of posted) check(seen.includes(id), `paging back should reach ${id}, got ${show(seen)}`)
    },
  },
  {
    group: 'paging',
    name: 'refuses to page threads back and forward at once',
    run: async (ctx) => {
      const first = await ctx.board.threads({ channel: ctx.channel, limit: 1 })
      if (!('older' in first)) return UNPAGED
      await rejects(ctx.board.threads({ channel: ctx.channel, before: first.older ?? 'x', after: ctx.start }), 400, 'invalid_request', 'threads with before and after')
    },
  },
  {
    group: 'core',
    name: 'stores a handle one actor has as a mention of them, and keeps one no one has as typed',
    run: async (ctx) => {
      check(ctx.root, "posting failed, so there's no thread to reply in")
      // The caller wrote the root, so the board knows it, and of any who share its handle it's the one in the thread.
      const { handle, actor } = ctx.me
      if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)?$/i.test(handle)) return `the caller's handle, ${handle}, isn't one a mention can type`
      const nobody = `conformance-nobody-${Date.now().toString(36)}`
      const sent = await reply(ctx, ctx.root.id, `conformance: over to @${handle} and @${nobody}`)
      const settled = `conformance: over to @[${actor}] and @${nobody}`
      check(sent.text === settled, `a handle one actor has should be stored as @[actor-id], and one no one has as typed: expected ${show(settled)}, got ${show(sent.text)}`)
      const [mine, none, ...more] = sent.mentions ?? []
      check(mine?.written === `@${handle}` && mine.actor?.id === actor, `the answer's mentions should say @${handle} mentions ${actor}, got ${show(mine)}`)
      check(none?.written === `@${nobody}` && none.actor === null && none.candidates.length === 0, `the answer's mentions should say @${nobody} mentions no one, got ${show(none)}`)
      check(more.length === 0, `the answer's mentions should have one entry a handle, got ${more.length + 2}`)
      const kept = (await ctx.board.thread(ctx.root.id)).replies.find((message) => message.id === sent.id)
      check(kept?.text === settled, `the message should read back as it was stored, got ${show(kept?.text)}`)
    },
  },
  {
    group: 'search',
    name: "finds threads by text anywhere in a message of theirs, in any case, as it reads now",
    run: async (ctx) => {
      // Roots of its own: the second matches the first's searches only where % or _ is a wildcard.
      const literal = await post(ctx, 'conformance: Deploy FAILED at 100% on a_b')
      const lookalike = await post(ctx, 'conformance: deploy failed at 1000 on axb')
      await reply(ctx, lookalike.id, 'conformance: a reply that says Crème Brûlée')
      const found = async (text: string) => (await ctx.board.threads({ channel: ctx.channel, label: ctx.labels, text })).threads.map((t) => t.message.id)
      alike(await found('DEPLOY failed'), [literal.id, lookalike.id], 'the threads "DEPLOY failed" finds')
      alike(await found('100%'), [literal.id], 'the threads "100%" finds, % being a character')
      alike(await found('a_b'), [literal.id], 'the threads "a_b" finds, _ being a character')
      // A thread by a reply's own text, in any case.
      alike(await found('crème BRÛLÉE'), [lookalike.id], 'the threads "crème BRÛLÉE" finds')
      // An edit changes what finds it.
      await ctx.board.edit(lookalike.id, 'conformance: deploy fixed')
      alike(await found('1000'), [], 'the threads "1000" finds, once the message that said it is edited')
      alike(await found('deploy fixed'), [lookalike.id], 'the threads "deploy fixed" finds, once a message is edited to say it')
    },
  },
  {
    group: 'search',
    name: 'lists the threads of every channel under a pattern at once',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const { threads } = await ctx.board.threads({ channel: `${ctx.channel}/`, label: ctx.labels })
      check(threads.some((t) => t.message.id === root.id), `the threads under ${ctx.channel}/ should include ${root.id}, in ${ctx.channel} itself`)
    },
  },
  {
    group: 'core',
    name: 'reads events after a cursor, each with a cursor of its own',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const page = await ctx.board.poll({ channel: ctx.channel, after: ctx.start })
      isRef(page.cursor, "the events' cursor")
      const posted = page.events.find((event) => event.type === 'message.posted' && event.message?.id === root.id)
      check(posted, `the events should include ${root.id} being posted`)
      isRef(posted.cursor, "an event's cursor")
      const next = await ctx.board.poll({ channel: ctx.channel, after: page.cursor })
      check(!next.events.some((event) => event.message?.id === root.id), 'reading on from the cursor should not repeat what it read')
    },
  },
  {
    group: 'core',
    name: "reads a channel's newest events, oldest first, and goes on from their cursor",
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const page = await ctx.board.poll({ channel: ctx.channel, last: 100 }).catch((error: unknown) => {
        // A board whose feed can't be read from its end says so, and is followed from now.
        if (error instanceof BoardError && error.status === 501 && error.code === 'not_supported') return `not kept here: ${error.message}`
        throw error
      })
      if (typeof page === 'string') return page
      isRef(page.cursor, "the newest events' cursor")
      const posted = page.events.filter((event) => event.type === 'message.posted').map((event) => event.message?.id)
      check(posted.includes(root.id) && posted.includes(reply.id), `the channel's newest events should include ${root.id} and ${reply.id} being posted`)
      check(posted.indexOf(root.id) < posted.indexOf(reply.id), `${root.id} was posted before ${reply.id}, so it should come first`)
      const one = await ctx.board.poll({ channel: ctx.channel, last: 1 })
      check(one.events.length <= 1, `\`last=1\` on one channel should answer one event at most, not ${one.events.length}`)
      const next = await ctx.board.poll({ channel: ctx.channel, after: page.cursor })
      check(!next.events.some((event) => page.events.some((read) => read.cursor === event.cursor)), 'reading on from the cursor should not repeat what it read')
    },
  },
  {
    group: 'core',
    name: 'holds a long-poll open until the next event',
    run: async (ctx) => {
      const { cursor } = await ctx.board.poll({ channel: ctx.channel, label: ctx.labels })
      const waiting = ctx.board.poll({ channel: ctx.channel, label: ctx.labels, after: cursor, wait: 10 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const later = await post(ctx, 'conformance: while it waits')
      const page = await waiting
      check(page.events.some((event) => event.message?.id === later.id), 'the long-poll should return the post made while it waited')
    },
  },
  {
    group: 'core',
    name: 'deletes a message, leaving a tombstone',
    run: async (ctx) => {
      const message = await post(ctx, 'conformance: to delete')
      await ctx.board.delete(message.id)
      const { message: after } = await ctx.board.thread(message.id)
      check(after.deleted && after.text === '', `a deleted message should be deleted with no text, got ${show({ deleted: after.deleted, text: after.text })}`)
    },
  },
  {
    group: 'core',
    // Labels are state agents read: a deleted task mustn't still look open.
    name: 'drops a deleted message from what its labels find',
    run: async (ctx) => {
      const label = { ...ctx.labels, tombstone: ctx.labels.conformance }
      const root = await ctx.board.post(ctx.channel, { text: 'conformance: a labeled root to delete', labels: label, noSync: true })
      ctx.posted.push(root.id)
      await reply(ctx, root.id, 'conformance: a reply under it')
      const found = async () => (await ctx.board.threads({ channel: ctx.channel, label })).threads.map((t) => t.message.id)
      const before = await found()
      check(before.includes(root.id), `its labels should find the root's thread before the delete, got ${show(before)}`)
      await ctx.board.delete(root.id)
      const { labels } = (await ctx.board.thread(root.id)).message
      check(Object.keys(labels).length === 0, `a deleted message should keep no labels, got ${show(labels)}`)
      const after = await found()
      check(!after.includes(root.id), `a label read should leave out a deleted root's thread, got ${show(after)}`)
    },
  },
  {
    group: 'core',
    name: 'lists the channel and you in it',
    run: async (ctx) => {
      const channels = await everyChannel(ctx.board)
      const found = channels.find((c) => c.path === ctx.channel)
      check(found, `the channels should include ${ctx.channel}`)
      // A board counts what it keeps, and leaves out what it doesn't: Vercel's API keeps no counts.
      for (const field of ['lastIndex', 'messages', 'threads'] as const)
        check(found[field] === undefined || typeof found[field] === 'number', `a channel's ${field} should be a number or left out, got ${show(found[field])}`)
      const actors = await ctx.board.actors()
      check(actors.some((a) => a.id === ctx.me.actor), `the actors should include ${ctx.me.actor}`)
    },
  },
  {
    group: 'core',
    // It makes none of its own: a board keeps every channel, and a run leaves nothing behind.
    name: 'creates a channel only once: one a post made is there already',
    run: async (ctx) => {
      needRoot(ctx)
      const { channel, created } = await ctx.board.createChannel(ctx.channel)
      same(created, false, `creating ${ctx.channel}, which this run posted to`)
      same(channel.path, ctx.channel, "the channel's path")
      await rejects(ctx.board.createChannel('Not A Channel'), 400, 'invalid_request', 'creating a malformed channel')
    },
  },
  {
    group: 'core',
    name: 'answers 404 for an ID that names nothing',
    run: async (ctx) => {
      await rejects(ctx.board.thread(`no-such-message-${ctx.labels.conformance}`), 404, 'message_not_found', 'reading a message that was never posted')
    },
  },
  {
    group: 'core',
    name: 'answers 400 for a request that does not validate',
    run: async (ctx) => {
      await rejects(ctx.board.post('Not A Channel', { text: 'conformance', noSync: true }), 400, 'invalid_request', 'posting to a malformed channel')
    },
  },
  {
    group: 'core',
    name: 'narrows a caller to what its x-board-can says',
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const { root } = needRoot(ctx)
      const narrowed = ctx.withCan(`${ctx.channel}=read`)
      const me = await narrowed.me()
      same(me.principal, ctx.me.principal, "a narrowed caller's principal, its own")
      alike(me.can, { [ctx.channel]: ['read'] }, 'what a caller narrowed to read says it may do')
      same((await narrowed.thread(root.id)).message.id, root.id, 'a thread read by a caller narrowed to read it')
      const posting = narrowed.post(ctx.channel, { text: 'conformance: narrowed to read', labels: ctx.labels, noSync: true }).then((message) => {
        ctx.posted.push(message.id)
        return message
      })
      await refused(posting, 403, 'a post by a caller narrowed to read')
    },
  },
  {
    group: 'core',
    name: 'takes a profile and its avatar as one x-board-profile header, and shows both on what it writes',
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      const name = `conformance-${ctx.labels.conformance}`
      const agent = ctx.withHeaders({ 'x-board-profile': `${name}; avatar="${AVATAR}"` })
      const posted = await agent.post(ctx.channel, { text: 'conformance: as a profile, with its avatar', labels: ctx.labels, noSync: true })
      ctx.posted.push(posted.id)
      const { message } = await ctx.board.thread(posted.id)
      same(message.by.principal, ctx.me.principal, "the profile's principal, this run's")
      same(message.by.profile?.toLowerCase(), name, 'the profile its header names')
      same(message.author?.kind, 'agent', "the profile's kind")
      same(message.author?.name, name, "the profile's name")
      same(message.author?.avatar, AVATAR, "the profile's avatar, from its header's parameter")
    },
  },
  {
    group: 'core',
    name: 'lets a profile change only its own messages, and its principal all of them',
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      if (ctx.me.actor !== ctx.me.principal) return "this run writes as a profile, so it can't change messages as its principal"
      const as = (name: string) => ctx.withHeaders!({ 'x-board-profile': `conformance-${name}-${ctx.labels.conformance}` })
      const by = async (poster: Board, text: string) => {
        const message = await poster.post(ctx.channel, { text, labels: ctx.labels, noSync: true })
        ctx.posted.push(message.id)
        return message
      }
      const profile = as('own')
      const own = await by(profile, "conformance: a profile's own")
      const other = await by(as('other'), "conformance: another profile's")
      const principal = await by(ctx.board, "conformance: its principal's")
      await profile.edit(own.id, "conformance: a profile's own, edited by it")
      same((await ctx.board.thread(own.id)).message.text, "conformance: a profile's own, edited by it", "a profile's own message, once it edits it")
      for (const [message, whose] of [[other, "another profile's"], [principal, "its principal's"]] as const) {
        await refused(profile.edit(message.id, 'conformance: not its own'), 403, `an edit, by a profile, of ${whose} message`)
        await refused(profile.delete(message.id), 403, `a delete, by a profile, of ${whose} message`)
      }
      await ctx.board.edit(other.id, "conformance: another profile's, edited by its principal")
      const edited = (await ctx.board.thread(other.id)).message
      same(edited.text, "conformance: another profile's, edited by its principal", "a profile's message, once its principal edits it")
      same(edited.by.actor, other.by.actor, "who a profile's message is by, once its principal edits it")
      for (const message of [own, other]) {
        await ctx.board.delete(message.id)
        check((await ctx.board.thread(message.id)).message.deleted, "a profile's message, once its principal deletes it, should be deleted")
      }
      await profile.delete((await by(profile, "conformance: a profile's own, to delete")).id)
    },
  },
  {
    group: 'core',
    name: "ignores x-board-avatar, which x-board-profile's avatar parameter replaced",
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      // A profile of its own: the one the check before gave an avatar would show it still.
      const name = `conformance-bare-${ctx.labels.conformance}`
      const message = await postedWith(ctx, ctx.withHeaders({ 'x-board-profile': name, 'x-board-avatar': AVATAR }), 'x-board-avatar')
      same(message.by.profile?.toLowerCase(), name, 'the profile its header names')
      same(message.author?.avatar ?? null, null, "the avatar of a profile whose header names none, whatever x-board-avatar says")
    },
  },
  {
    group: 'core',
    name: 'ignores x-board-session: who writes is the principal and its profile',
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      const message = await postedWith(ctx, ctx.withHeaders({ 'x-board-session': `conformance-${ctx.labels.conformance}` }), 'x-board-session')
      same(message.by.actor, ctx.me.actor, 'who a post with x-board-session is by: this run, as itself')
      noSession(message.by, 'a post with x-board-session')
    },
  },
  {
    group: 'core',
    name: 'shows no session on a message, its event, or you',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      noSession((await ctx.board.thread(root.id)).message.by, 'a message')
      const { events } = await ctx.board.poll({ channel: ctx.channel, after: ctx.start, label: ctx.labels, wait: 0 })
      const posted = events.find((event) => event.type === 'message.posted')
      check(posted !== undefined, `events after the run's start should hold its post, got ${show(events.map((event) => event.type))}`)
      noSession((posted.payload as { by?: unknown }).by, "a message.posted event's payload")
      check(!('session' in ctx.me), `you should carry no session, got ${show(ctx.me)}`)
    },
  },
  {
    group: 'schedules',
    name: 'schedules a reply, lists it, and cancels it',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const schedule = await ctx.board.schedule({ re: root.id }, { text: 'conformance: later', noSync: true, in: '1d' })
      isRef(schedule.id, "a schedule's id")
      same(schedule.re, root.id, "the schedule's re")
      same(schedule.state, 'pending', "the schedule's state")
      const listed = await ctx.board.schedules({ re: root.id })
      check(listed.some((s) => s.id === schedule.id), `the schedules should include ${schedule.id}`)
      const { schedule: canceled } = await ctx.board.cancelSchedule(schedule.id)
      same(canceled.state, 'canceled', 'the canceled schedule')
    },
  },
  {
    group: 'schedules',
    name: 'keeps noSync on a schedule, so its sends stay off every platform',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const schedule = await ctx.board.schedule({ re: root.id }, { text: 'conformance: later, on the board only', noSync: true, in: '1d' })
      try {
        same(schedule.noSync, true, "the schedule's noSync")
        same((await ctx.board.schedules({ re: root.id })).find((s) => s.id === schedule.id)?.noSync, true, "the listed schedule's noSync")
      } finally {
        await ctx.board.cancelSchedule(schedule.id).catch(() => {})
      }
    },
  },
  {
    group: 'tasks',
    name: 'starts a thread as a task, or makes one of a thread that was there: it reads as its thread, and board.task finds it',
    run: async (ctx) => {
      const { task: root } = await task(ctx, 'conformance: a task')
      isRef(root.id, "a task's id")
      same(root.task?.state, 'ready', "a new task's state")
      same(root.task?.owner, ctx.me.principal, "a new task's owner")
      same(root.task?.by, ctx.me.actor, 'the actor a new task was made as')
      same(root.labels['board.task'], 'ready', "its root's board.task")
      const answer = await reply(ctx, root.id, 'conformance: working on it')
      const thread = await ctx.board.thread(root.id)
      same(thread.message.task?.state, 'ready', 'the task, read as its thread')
      check(thread.replies.some((m) => m.id === answer.id), "a reply should land in the task's thread")
      const { threads } = await ctx.board.threads({ channel: ctx.channel, label: { ...ctx.labels, 'board.task': 'ready' } })
      check(threads.some((t) => t.message.id === root.id), 'board.task=ready should find the task')
      const listed = (await ctx.board.tasks.list({ channel: ctx.channel, label: ctx.labels })).tasks.find((t) => t.message.id === root.id)
      check(listed, `the tasks should include ${root.id}`)
      same(listed.replies, 1, "the listed task's reply count")
      same(listed.last?.id, answer.id, "the listed task's latest reply")
      // A thread that was there, made a task as it is.
      const plain = await post(ctx, 'conformance: a thread to make a task')
      await rejects(ctx.board.tasks.claim(plain.id), 404, 'not_a_task', "claiming a thread that isn't a task")
      const adopted = await ctx.board.tasks.create({ re: plain.id })
      same(adopted.task.id, plain.id, "the task's id, its root's")
      same(adopted.task.text, 'conformance: a thread to make a task', "the task's text, its root's")
      same((await ctx.board.thread(plain.id)).message.labels['board.task'], 'ready', "the thread's board.task, once it's a task")
      await rejects(ctx.board.tasks.create({ re: plain.id }), 409, 'already_a_task', 'making a task of a thread that is one')
    },
  },
  {
    group: 'tasks',
    name: 'makes a task once for a client ID, and none under an ID a reply or a plain thread landed with',
    run: async (ctx) => {
      const id = `conformance-task-${ctx.labels.conformance}`
      const under = (landed: string, text: string) =>
        ctx.board.tasks.create(ctx.channel, { text, labels: ctx.labels, noSync: true, id: landed }).then((made) => {
          ctx.posted.push(made.task.id)
          return made
        })
      const { task: first } = await under(id, 'conformance: a task with an ID')
      same((await under(id, 'conformance: a task with an ID')).task.id, first.id, 'the second task with the same client ID')
      // An ID something else landed with names no task: a create under it is another write's, and makes nothing.
      await reply(ctx, first.id, 'conformance: a reply with an ID', { id: `${id}-reply` })
      const plain = await post(ctx, 'conformance: a thread with an ID', { id: `${id}-thread` })
      await rejects(under(`${id}-reply`, 'conformance: a task under a reply\'s ID'), 409, 'duplicate_id', 'a task under an ID a reply landed with')
      await rejects(under(`${id}-thread`, 'conformance: a task under a thread\'s ID'), 409, 'duplicate_id', 'a task under an ID a thread that is no task landed with')
      same((await ctx.board.thread(plain.id)).message.task, undefined, 'the thread, after a task was asked for under its ID')
      same((await ctx.board.tasks.list({ channel: ctx.channel, label: ctx.labels, state: 'all' })).tasks.filter((listed) => listed.message.text.includes('with an ID') || listed.message.text.includes("'s ID")).length, 1, 'the tasks made under those IDs')
    },
  },
  {
    group: 'tasks',
    name: 'gives a task to one of the claims that race for it, and takes its result',
    run: async (ctx) => {
      const { task: root } = await task(ctx, 'conformance: a task to race for')
      const racing = await Promise.allSettled([1, 2, 3].map(() => ctx.board.tasks.claim(root.id, { lease: 60 })))
      const landed = racing.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      same(landed.length, 1, 'the claims that landed of three racing for one task')
      lostRace(racing)
      const claim = landed[0]!
      same(claim.task.task?.state, 'claimed', 'the task, once claimed')
      same(claim.task.labels['board.task'], 'claimed', "its root's board.task, once claimed")
      same(claim.task.task?.claim?.actor, ctx.me.actor, 'who holds it')
      check(typeof claim.token === 'string' && claim.token.length > 0, `a claim's token should be a string, got ${show(claim.token)}`)
      check(!show(await ctx.board.thread(root.id)).includes(claim.token), "a task's thread shouldn't show its claim's token")
      const done = await claim.complete('conformance: done')
      same(done.task?.state, 'completed', 'the task, once completed')
      same(done.task?.result, 'conformance: done', "the completed task's result")
      await rejects(ctx.board.tasks.claim(root.id), 409, 'task_finished', 'claiming a completed task')
    },
  },
  {
    group: 'tasks',
    name: 'gives a claim the lease it asks for, up to 5 minutes, and says when it ends',
    run: async (ctx) => {
      const { task: root } = await task(ctx, 'conformance: a task to hold')
      const asked = Date.now()
      const claim = await ctx.board.tasks.claim(root.id, { lease: 300 })
      const lease = Date.parse(claim.until) - asked
      check(lease >= 295_000 && lease <= 305_000 + (Date.now() - asked), `a claim that asks for 300 seconds should end in 300, got ${claim.until}`)
      same(claim.task.task?.claim?.until, claim.until, "the task's own word for when its claim ends")
      const again = Date.now()
      const renewed = await claim.renew(60)
      const left = Date.parse(renewed.until) - again
      check(left >= 55_000 && left <= 65_000 + (Date.now() - again), `a claim renewed for 60 seconds should end in 60, got ${renewed.until}`)
      await renewed.release()
      // Without one, a board gives its own, and none gives under 5 minutes.
      const fallback = Date.now()
      const unasked = await ctx.board.tasks.claim(root.id)
      check(Date.parse(unasked.until) - fallback >= 295_000, `a claim that asks for no lease should get at least 5 minutes, got ${unasked.until}`)
      await unasked.release()
      await rejects(ctx.board.tasks.claim(root.id, { lease: 5 }), 400, 'invalid_request', 'a lease under 30 seconds')
    },
  },
  {
    group: 'tasks',
    name: "fences what a claim does: once it's over, its writes are lost and change nothing",
    run: async (ctx) => {
      const { task: root } = await task(ctx, 'conformance: a task to take over')
      const first = await ctx.board.tasks.claim(root.id, { lease: 60 })
      await rejects(ctx.board.tasks.held(root.id, { epoch: first.epoch, token: `${first.token}x` }).complete('conformance: not mine'), 409, 'claim_lost', "a complete with a token that isn't the claim's")
      same(await taskState(ctx, root.id), 'claimed', 'the task, after a write with the wrong token')
      same((await first.release()).task?.state, 'ready', 'the task, once released')
      await rejects(first.renew(), 409, 'claim_lost', 'renewing a claim that was released')
      const second = await ctx.board.tasks.claim(root.id, { lease: 60 })
      same(second.epoch, first.epoch + 1, 'the epoch of the claim after it')
      await rejects(first.complete('conformance: too late'), 409, 'claim_lost', "the first claim's complete, once another holds the task")
      await rejects(first.fail('conformance: too late'), 409, 'claim_lost', "the first claim's fail, once another holds the task")
      const held = (await ctx.board.thread(root.id)).message.task
      check(held?.state === 'claimed' && held.epoch === second.epoch && held.result === null, `lost writes should leave the task with the claim that holds it, got ${show(held)}`)
      const failed = await second.fail('conformance: could not')
      same(failed.task?.state, 'failed', 'the task, once failed')
      same(failed.task?.reason, 'conformance: could not', "the failed task's reason")
      same((await ctx.board.tasks.reopen(root.id)).task?.state, 'ready', 'a failed task, reopened')
    },
  },
  {
    group: 'tasks',
    name: 'holds a task until the tasks it needs complete, which a failed or canceled one never does',
    run: async (ctx) => {
      const { task: first } = await task(ctx, 'conformance: a prerequisite')
      const { task: second } = await task(ctx, 'conformance: a task that waits for it', { needs: [first.id] })
      same(second.task?.state, 'waiting', 'a task that needs one that has not completed')
      same(second.labels['board.task'], 'waiting', "its root's board.task")
      alike(second.task?.needs, [first.id], 'what it needs')
      await rejects(ctx.board.tasks.claim(second.id), 409, 'task_waiting', 'claiming a task that waits')
      // A failed one doesn't ready it; reopened and completed, it does.
      await (await ctx.board.tasks.claim(first.id, { lease: 60 })).fail('conformance: not this time')
      same(await taskState(ctx, second.id), 'waiting', 'the task, once what it needs failed')
      await ctx.board.tasks.reopen(first.id)
      await (await ctx.board.tasks.claim(first.id, { lease: 60 })).complete()
      await soon(async () => (await taskState(ctx, second.id)) === 'ready', 'the task should be ready once what it needs completed')
      // Nor does a canceled one.
      const { task: dropped } = await task(ctx, 'conformance: a prerequisite to cancel')
      const { task: stuck } = await task(ctx, 'conformance: a task that waits for that', { needs: [dropped.id] })
      const canceled = await ctx.board.tasks.cancel(dropped.id, 'conformance: not wanted')
      same(canceled.task?.state, 'canceled', 'a canceled task')
      same(canceled.task?.reason, 'conformance: not wanted', "the canceled task's reason")
      same(await taskState(ctx, stuck.id), 'waiting', 'the task, once what it needs was canceled')
      // What it needs is a task: a thread that isn't one, or the task itself, is refused.
      const plain = await post(ctx, 'conformance: not a task')
      const waiting = ctx.board.tasks.create(ctx.channel, { text: 'conformance: needs a thread', labels: ctx.labels, noSync: true, needs: [plain.id] }).then((made) => {
        ctx.posted.push(made.task.id)
        return made
      })
      await rejects(waiting, 400, 'invalid_needs', "a task that needs a thread that isn't a task")
      await rejects(ctx.board.tasks.create({ re: plain.id }, { needs: [plain.id] }), 400, 'invalid_needs', 'a task that needs itself')
    },
  },
  {
    group: 'tasks',
    name: 'refuses a prerequisite that was canceled, which can never complete, and takes one that failed',
    run: async (ctx) => {
      const { task: dropped } = await task(ctx, 'conformance: a prerequisite that was canceled')
      await ctx.board.tasks.cancel(dropped.id, 'conformance: not wanted')
      // A task that waited for it would wait for good, so whoever makes one hears at once: a new thread, or one that's there.
      const waiting = ctx.board.tasks.create(ctx.channel, { text: 'conformance: needs a canceled task', labels: ctx.labels, noSync: true, needs: [dropped.id] }).then((made) => {
        ctx.posted.push(made.task.id)
        return made
      })
      await rejects(waiting, 400, 'invalid_needs', 'a task that needs a canceled one')
      const plain = await post(ctx, 'conformance: a thread that would need a canceled task')
      await rejects(ctx.board.tasks.create({ re: plain.id }, { needs: [dropped.id] }), 400, 'invalid_needs', 'making a thread a task that needs a canceled one')
      same((await ctx.board.thread(plain.id)).message.task, undefined, 'the thread, after it was refused as a task')
      // A failed one may be reopened, so it's still something to wait for.
      const { task: failed } = await task(ctx, 'conformance: a prerequisite that failed')
      await (await ctx.board.tasks.claim(failed.id, { lease: 60 })).fail('conformance: not this time')
      const { task: after } = await task(ctx, 'conformance: a task that waits for a failed one', { needs: [failed.id] })
      same(after.task?.state, 'waiting', 'a task that needs one that failed')
      alike(after.task?.needs, [failed.id], 'what it needs')
    },
  },
  {
    group: 'tasks',
    name: 'lists the tasks that wait for one in the channel a list names, or its subtree, and no other',
    run: async (ctx) => {
      const beside = besideOf(ctx)
      const { task: first } = await task(ctx, 'conformance: a prerequisite two channels wait for')
      const { task: here } = await task(ctx, 'conformance: a task that waits for it, in the channel', { needs: [first.id] })
      alike(here.task?.needs, [first.id], 'what the task in the channel needs')
      const made = await taskBeside(ctx, 'conformance: a task that waits for it, in another channel', { needs: [first.id] })
      if (!made) return `this token can't post in ${beside}`
      const there = made.task
      const waiting = async (channel?: string) => (await ctx.board.tasks.list({ needs: first.id, ...(channel !== undefined ? { channel } : {}) })).tasks.map((listed) => listed.message.id)
      // A list may trail a write by a moment: once the board's own has both, each channel's is read as it is.
      await soon(async () => show(await waiting()) === show([here.id, there.id]), 'the tasks that wait for one, on the whole board, should be the two that do')
      alike(await waiting(ctx.channel), [here.id], `the tasks that wait for one, in ${ctx.channel}`)
      alike(await waiting(beside), [there.id], `the tasks that wait for one, in ${beside}`)
      alike(await waiting(`${beside}/`), [there.id], `the tasks that wait for one, under ${beside}/`)
      alike(await waiting(`${ctx.channel}/`), [here.id, there.id], `the tasks that wait for one, under ${ctx.channel}/`)
    },
  },
  {
    group: 'tasks',
    name: 'lists the last active tasks with latest, wherever they come in the order they were made',
    run: async (ctx) => {
      // This check's own label, so the run's other tasks aren't among them.
      const labels = { ...ctx.labels, 'conformance-latest': ctx.labels.conformance }
      const { task: first } = await task(ctx, 'conformance: made first, active last', { labels })
      const { task: second } = await task(ctx, 'conformance: made second, active first', { labels })
      const { task: third } = await task(ctx, 'conformance: made third, active second', { labels })
      // A board orders by time and nothing finer, so each reply comes a moment after the last.
      for (const root of [second, third, first]) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await reply(ctx, root.id, 'conformance: progress')
      }
      const listed = async (query: { latest?: boolean; limit: number }) => (await ctx.board.tasks.list({ channel: ctx.channel, label: labels, state: 'all', ...query })).tasks.map((t) => t.message.id)
      // A list may trail a write by a moment.
      await soon(async () => show(await listed({ latest: true, limit: 3 })) === show([second.id, third.id, first.id]), 'with latest, the tasks should list the latest active last')
      alike(await listed({ latest: true, limit: 2 }), [third.id, first.id], 'the 2 last active, with latest')
      alike(await listed({ limit: 2 }), [first.id, second.id], 'the 2 first made, without it')
      const last = (await ctx.board.tasks.list({ channel: ctx.channel, label: labels, state: 'all', latest: true, limit: 1 })).tasks[0]!
      same(last.last?.text, 'conformance: progress', "a last active task's latest reply")
      await rejects(ctx.board.tasks.list({ channel: ctx.channel, latest: true, after: first.id }), 400, 'invalid_request', 'latest with an after')
    },
  },
  {
    group: 'tasks',
    name: 'says task.ready each time a task that needs others becomes ready: right after it is made or unblocked, once they have completed',
    run: async (ctx) => {
      const { task: first } = await task(ctx, 'conformance: a prerequisite that completes first')
      await (await ctx.board.tasks.claim(first.id, { lease: 60 })).complete()
      const label = [`conformance=${ctx.labels.conformance}`]
      let { cursor } = await ctx.board.poll({ channel: ctx.channel, label })
      // Made with a claim once what it needs completed: it waits as it's made, is ready in the same write, and is claimed after.
      const made = await task(ctx, 'conformance: a task made once what it needs completed', { needs: [first.id], claim: true, lease: 60 })
      const { id } = made.task
      same(made.task.task?.state, 'claimed', 'a task made with a claim, once what it needs completed')
      check(made.claim, 'a task made with a claim should answer the claim')
      await ctx.board.tasks.held(id, made.claim).block('conformance: approve?')
      // One that needs none is ready as it's made and as it's unblocked, with no task.ready.
      const { task: alone } = await task(ctx, 'conformance: a task that needs none')
      await ctx.board.tasks.block(alone.id, 'conformance: approve?')
      same((await ctx.board.tasks.unblock(alone.id)).task?.state, 'ready', 'a task that needs none, unblocked')
      same((await ctx.board.tasks.unblock(id)).task?.state, 'ready', 'the task, unblocked once what it needs completed')
      const seen: Awaited<ReturnType<Board['poll']>>['events'] = []
      const changes = (of: string) => seen.filter((event) => event.type.startsWith('task.') && event.message?.id === of).map((event) => [event.type, event.message?.task?.state])
      // Its second task.ready is the last of them written.
      for (const deadline = Date.now() + 10_000; changes(id).filter(([type]) => type === 'task.ready').length < 2 && Date.now() < deadline; ) {
        const page = await ctx.board.poll({ channel: ctx.channel, label, after: cursor, wait: 2 })
        seen.push(...page.events)
        cursor = page.cursor
      }
      alike(
        changes(id),
        [
          ['task.created', 'waiting'],
          ['task.ready', 'ready'],
          ['task.claimed', 'claimed'],
          ['task.blocked', 'blocked'],
          ['task.unblocked', 'waiting'],
          ['task.ready', 'ready'],
        ],
        'the changes of a task made and unblocked once what it needs completed, with its state after each',
      )
      alike(
        changes(alone.id),
        [
          ['task.created', 'ready'],
          ['task.blocked', 'blocked'],
          ['task.unblocked', 'ready'],
        ],
        'the changes of a task that needs none, with its state after each',
      )
    },
  },
  {
    group: 'tasks',
    name: 'changes what a task needs: it waits for the new ones, is ready once they have completed, and at once with none',
    run: async (ctx) => {
      const { task: done } = await task(ctx, 'conformance: a prerequisite that has completed')
      await (await ctx.board.tasks.claim(done.id, { lease: 60 })).complete()
      const { task: open } = await task(ctx, 'conformance: a prerequisite that has not')
      const { task: root } = await task(ctx, 'conformance: a task whose needs change')
      const label = [`conformance=${ctx.labels.conformance}`]
      let { cursor } = await ctx.board.poll({ channel: ctx.channel, label })
      // A ready task waits again, for one that hasn't completed.
      const waiting = await ctx.board.tasks.needs(root.id, [open.id])
      same(waiting.task?.state, 'waiting', 'a ready task, once it needs one that has not completed')
      same(waiting.labels['board.task'], 'waiting', "its root's board.task")
      alike(waiting.task?.needs, [open.id], 'what it needs now')
      await rejects(ctx.board.tasks.claim(root.id), 409, 'task_waiting', 'claiming a task that came to wait')
      // For ones that have completed, it's ready in the same write, and the same set again changes nothing.
      const ready = await ctx.board.tasks.needs(root.id, [done.id])
      same(ready.task?.state, 'ready', 'the task, once it needs only what has completed')
      alike(ready.task?.needs, [done.id], 'what it needs now')
      same((await ctx.board.tasks.needs(root.id, [done.id, done.id])).task?.state, 'ready', 'the task, after the same needs again')
      // With none it's ready at once.
      await ctx.board.tasks.needs(root.id, [open.id])
      const none = await ctx.board.tasks.needs(root.id, [])
      same(none.task?.state, 'ready', 'the task, once it needs nothing')
      alike(none.task?.needs, [], 'what it needs now')
      // One held for a person stays held, and stands where what it needs now puts it once the hold is lifted.
      await ctx.board.tasks.block(root.id, 'conformance: approve?')
      same((await ctx.board.tasks.needs(root.id, [done.id])).task?.state, 'blocked', 'a held task, once what it needs changed')
      same((await ctx.board.tasks.unblock(root.id)).task?.state, 'ready', 'the task, unblocked, once what it needs now has completed')
      const seen: Awaited<ReturnType<Board['poll']>>['events'] = []
      const changes = () => seen.filter((event) => event.type.startsWith('task.') && event.message?.id === root.id).map((event) => [event.type, event.message?.task?.state])
      // Its second task.ready is the last of them written.
      for (const deadline = Date.now() + 10_000; changes().filter(([type]) => type === 'task.ready').length < 2 && Date.now() < deadline; ) {
        const page = await ctx.board.poll({ channel: ctx.channel, label, after: cursor, wait: 2 })
        seen.push(...page.events)
        cursor = page.cursor
      }
      alike(
        changes(),
        [
          ['task.needs_changed', 'waiting'],
          ['task.needs_changed', 'waiting'],
          ['task.ready', 'ready'],
          ['task.needs_changed', 'waiting'],
          ['task.needs_changed', 'ready'],
          ['task.blocked', 'blocked'],
          ['task.needs_changed', 'blocked'],
          ['task.unblocked', 'waiting'],
          ['task.ready', 'ready'],
        ],
        "the changes of a task whose needs changed, with its state after each",
      )
    },
  },
  {
    group: 'tasks',
    name: 'refuses a change of needs that would make a task wait for itself, straight back or through others',
    run: async (ctx) => {
      const { task: first } = await task(ctx, 'conformance: the first of a line')
      const { task: second } = await task(ctx, 'conformance: waits for the first', { needs: [first.id] })
      const { task: third } = await task(ctx, 'conformance: waits for the second', { needs: [second.id] })
      await rejects(ctx.board.tasks.needs(first.id, [first.id]), 400, 'invalid_needs', 'a task that would need itself')
      await rejects(ctx.board.tasks.needs(first.id, [second.id]), 400, 'invalid_needs', 'a task that would need one that waits for it')
      await rejects(ctx.board.tasks.needs(first.id, [third.id]), 400, 'invalid_needs', 'a task that would need one that waits for it through another')
      // What a new task can't need, a change can't either.
      const { task: dropped } = await task(ctx, 'conformance: a prerequisite that was canceled, for a change')
      await ctx.board.tasks.cancel(dropped.id, 'conformance: not wanted')
      const plain = await post(ctx, 'conformance: not a task, for a change')
      await rejects(ctx.board.tasks.needs(first.id, [dropped.id]), 400, 'invalid_needs', 'a task that would need a canceled one')
      await rejects(ctx.board.tasks.needs(first.id, [plain.id]), 400, 'invalid_needs', "a task that would need a thread that isn't a task")
      const left = (await ctx.board.thread(first.id)).message.task
      same(left?.state, 'ready', 'the task, after the refused changes')
      alike(left?.needs, [], 'what it needs, after the refused changes')
      // Once the task between them waits for nothing, the same change closes no cycle.
      await ctx.board.tasks.needs(second.id, [])
      const moved = await ctx.board.tasks.needs(first.id, [third.id])
      same(moved.task?.state, 'waiting', 'the task, once it needs one that no longer waits for it')
      alike(moved.task?.needs, [third.id], 'what it needs now')
    },
  },
  {
    group: 'tasks',
    name: 'changes what a task needs only while no one holds it and it has not finished',
    run: async (ctx) => {
      const { task: other } = await task(ctx, 'conformance: something to wait for')
      const { task: root } = await task(ctx, 'conformance: a task someone holds, whose needs stay')
      const claim = await ctx.board.tasks.claim(root.id, { lease: 60 })
      await rejects(ctx.board.tasks.needs(root.id, [other.id]), 409, 'task_claimed', 'changing what a claimed task needs')
      const held = (await ctx.board.thread(root.id)).message.task
      same(held?.state, 'claimed', 'the task, after the refused change')
      alike(held?.needs, [], 'what it needs, after the refused change')
      // Released, it's no one's, and the change lands.
      await claim.release()
      same((await ctx.board.tasks.needs(root.id, [other.id])).task?.state, 'waiting', 'the task, once released and waiting for another')
      await ctx.board.tasks.needs(root.id, [])
      // A finished task's needs stay as they were: completed, failed, or canceled.
      await (await ctx.board.tasks.claim(root.id, { lease: 60 })).complete()
      await rejects(ctx.board.tasks.needs(root.id, [other.id]), 409, 'task_finished', 'changing what a completed task needs')
      const { task: failed } = await task(ctx, 'conformance: a task that fails, whose needs stay')
      await (await ctx.board.tasks.claim(failed.id, { lease: 60 })).fail('conformance: not this time')
      await rejects(ctx.board.tasks.needs(failed.id, [other.id]), 409, 'task_finished', 'changing what a failed task needs')
      const { task: dropped } = await task(ctx, 'conformance: a task that is canceled, whose needs stay')
      await ctx.board.tasks.cancel(dropped.id, 'conformance: not wanted')
      await rejects(ctx.board.tasks.needs(dropped.id, [other.id]), 409, 'task_finished', 'changing what a canceled task needs')
    },
  },
  {
    group: 'tasks',
    name: 'makes several tasks in one write, in the order given: each waits for the ones it names, of the batch or there already, and an id makes them once',
    run: async (ctx) => {
      const { task: done } = await task(ctx, 'conformance: a prerequisite that has completed')
      await (await ctx.board.tasks.claim(done.id, { lease: 60 })).complete()
      const { task: open } = await task(ctx, 'conformance: a prerequisite that has not')
      const id = `conformance-batch-${ctx.labels.conformance}`
      const plan: TaskInBatch[] = [
        { key: 'review', text: 'conformance: batched, waits for the one after it', needs: [{ key: 'fix' }] },
        { key: 'fix', text: 'conformance: batched, waits for nothing' },
        { text: 'conformance: batched, waits for one that has completed', needs: [done.id] },
        { text: 'conformance: batched, waits for one that has not, and for one of the batch', needs: [open.id, { key: 'fix' }] },
      ]
      const made = await taskBatch(ctx, plan, { id })
      alike(made.map((root) => root.text), plan.map((one) => one.text), "a batch's tasks, in the order it gave them")
      const [review, fix, after, both] = made as [MessageView, MessageView, MessageView, MessageView]
      for (const root of made) isRef(root.id, "a batched task's id")
      same(new Set(made.map((root) => root.id)).size, made.length, "the batch's different IDs")
      same(fix.task?.state, 'ready', 'a batched task that needs nothing')
      same(fix.task?.owner, ctx.me.principal, "a batched task's owner")
      same(fix.labels['board.task'], 'ready', "its root's board.task")
      same(review.task?.state, 'waiting', 'a batched task that needs a later one of the batch')
      alike(review.task?.needs, [fix.id], 'what it needs, by the ID the batch gave that task')
      same(after.task?.state, 'ready', 'a batched task whose needs were all there and have completed')
      alike(after.task?.needs, [done.id], 'what it needs')
      same(both.task?.state, 'waiting', 'a batched task that needs one of the batch and one that has not completed')
      alike(both.task?.needs?.slice().sort(), [open.id, fix.id].sort(), 'what it needs')
      // Each is the thread it reads as, and they list in the order given.
      same((await ctx.board.thread(review.id)).message.task?.state, 'waiting', 'a batched task, read as its thread')
      const mine = async () => (await ctx.board.tasks.list({ channel: ctx.channel, label: ctx.labels, state: 'all', limit: 500 })).tasks.map((listed) => listed.message).filter((root) => root.text.startsWith('conformance: batched,'))
      alike((await mine()).map((root) => root.id), made.map((root) => root.id), 'the batch, listed')
      // The same id again answers the tasks it made, and makes none. With other tasks, it's another write's.
      const again = await ctx.board.tasks.createMany(ctx.channel, plan.map((one) => ({ ...one, labels: ctx.labels, noSync: true })), { id })
      alike(again.map((root) => root.id), made.map((root) => root.id), 'the tasks a retry with the same id answers')
      await rejects(taskBatch(ctx, [...plan, { text: 'conformance: batched, one more under the same id' }], { id }), 409, 'duplicate_id', 'another batch under the same id')
      // As many tasks but other ones is another request too: the id names what was asked for, not how much of it.
      const others = plan.map((one, at) => (at === 1 ? { ...one, text: 'conformance: batched, another plan of the same size under the same id' } : one))
      await rejects(taskBatch(ctx, others, { id }), 409, 'duplicate_id', 'another plan of the same size under the same id')
      same((await mine()).length, made.length, 'the tasks made under that id')
      // One of the batch that completes readies what waited only for it, as any task does.
      await (await ctx.board.tasks.claim(fix.id, { lease: 60 })).complete()
      await soon(async () => (await taskState(ctx, review.id)) === 'ready', 'a batched task should be ready once the one it waited for completed')
      same(await taskState(ctx, both.id), 'waiting', 'the batched task that still waits for one that has not completed')
    },
  },
  {
    group: 'tasks',
    name: 'makes none of a batch when one of its tasks can not be made, wherever it comes in it',
    run: async (ctx) => {
      const { task: gone } = await task(ctx, 'conformance: a prerequisite that was canceled')
      await ctx.board.tasks.cancel(gone.id, 'conformance: not wanted')
      const fine: TaskInBatch[] = [
        { key: 'a', text: 'conformance: never made, first of a refused batch' },
        { text: 'conformance: never made, second of a refused batch', needs: [{ key: 'a' }] },
      ]
      const refused = (last: TaskInBatch[], what: string) => rejects(taskBatch(ctx, [...fine, ...last]), 400, 'invalid_needs', what)
      await refused([{ text: 'conformance: never made, waits for no one', needs: [{ key: 'nobody' }] }], 'a batch with a task that needs a key no task of it has')
      await refused([{ key: 'a', text: 'conformance: never made, a second a' }], 'a batch with a key two of its tasks have')
      await refused([{ key: 'itself', text: 'conformance: never made, waits for itself', needs: [{ key: 'itself' }] }], 'a batch with a task that needs itself')
      await refused(
        [
          { key: 'x', text: 'conformance: never made, waits for y', needs: [{ key: 'y' }] },
          { key: 'y', text: 'conformance: never made, waits for x', needs: [{ key: 'x' }] },
        ],
        'a batch with tasks that wait for each other',
      )
      await refused([{ text: 'conformance: never made, waits for a canceled one', needs: [gone.id] }], 'a batch whose last task needs one that was canceled')
      // More than a batch makes is refused by the handle this runs through, before the board is asked: its own tests check that.
      const { tasks } = await ctx.board.tasks.list({ channel: ctx.channel, label: ctx.labels, state: 'all', limit: 500 })
      const left = tasks.filter((listed) => listed.message.text.startsWith('conformance: never made'))
      check(left.length === 0, `a refused batch should make none of its tasks, and these are there: ${show(left.map((listed) => listed.message.text))}`)
    },
  },
  {
    group: 'tasks',
    name: 'holds a task for a person, by its owner or its claim, and gives it back when unblocked',
    run: async (ctx) => {
      const { task: root } = await task(ctx, 'conformance: a task to hold for a person')
      const blocked = await ctx.board.tasks.block(root.id, 'conformance: approve?', { kind: 'awaiting_approval' })
      same(blocked.task?.state, 'blocked', 'a held task')
      alike(blocked.task?.blocked, { kind: 'awaiting_approval', reason: 'conformance: approve?' }, 'what it is held for')
      await rejects(ctx.board.tasks.claim(root.id), 409, 'task_blocked', 'claiming a held task')
      same((await ctx.board.tasks.unblock(root.id)).task?.state, 'ready', 'the task, unblocked')
      // A claimed task's hold is its claim's, and ends it.
      const claim = await ctx.board.tasks.claim(root.id, { lease: 60 })
      await rejects(ctx.board.tasks.block(root.id, 'conformance: without the claim'), 409, 'task_claimed', 'holding a claimed task without its claim')
      same((await claim.block('conformance: which one?', { kind: 'needs_input' })).task?.state, 'blocked', 'a claimed task, held by its claim')
      await rejects(claim.complete(), 409, 'claim_lost', 'completing with a claim that held the task')
      await ctx.board.tasks.unblock(root.id)
      await ctx.board.tasks.cancel(root.id, 'conformance: done checking')
      await rejects(ctx.board.tasks.claim(root.id), 409, 'task_finished', 'claiming a canceled task')
      await rejects(ctx.board.tasks.cancel(root.id, 'conformance: again'), 409, 'task_finished', 'canceling a canceled task')
    },
  },
  {
    group: 'tasks',
    name: 'keeps a task assigned to a profile for that actor alone',
    run: async (ctx) => {
      // The same credential, as a profile of its own: its actor, under the run's principal.
      const fixer = ctx.board.as('conformance')
      const assignee = await fixer.me()
      if (assignee.principal !== ctx.me.principal) return "this handle's profiles are principals of their own, so none is its principal's actor"
      if (assignee.actor === ctx.me.actor) return 'this credential writes as one actor only, so no other actor of its principal can try'
      const { task: root } = await task(ctx, 'conformance: a task for one profile', { for: assignee.actor })
      same(root.task?.for, assignee.actor, 'who the task is for')
      await rejects(ctx.board.tasks.claim(root.id), 409, 'task_assigned', 'claiming a task assigned to another actor')
      const claim = await fixer.tasks.claim(root.id, { lease: 60 })
      same(claim.task.task?.claim?.actor, assignee.actor, 'who holds it')
      await claim.release()
      // Back in the pool, anyone who may claims it.
      same((await ctx.board.tasks.assign(root.id, null)).task?.for, null, 'who the task is for, back in the pool')
      await (await ctx.board.tasks.claim(root.id, { lease: 60 })).release()
      await rejects(ctx.board.tasks.assign(root.id, 'conformance:not-an-actor-of-its-owner'), 400, 'invalid_request', "assigning a task to an actor that isn't its owner's")
    },
  },
  {
    group: 'tasks',
    name: 'lets a profile change only the tasks it made, and its principal all of them',
    run: async (ctx) => {
      // A board that keeps no tasks says so first, whatever the run can send.
      const { task: principals } = await task(ctx, "conformance: its principal's task")
      if (!ctx.withHeaders) return NO_HEADERS
      if (ctx.me.actor !== ctx.me.principal) return "this run writes as a profile, so it can't change tasks as its principal"
      // Without manage, which changes anyone's task: what's left is whose task it is.
      const can = `${ctx.channel}=read,post,react,label`
      const as = (name: string) => ctx.withHeaders!({ 'x-board-profile': `conformance-${name}-${ctx.labels.conformance}`, 'x-board-can': can })
      const principal = ctx.withHeaders({ 'x-board-can': can })
      const profile = as('own')
      const sibling = as('other')
      const [actor, other] = await Promise.all([profile.me(), sibling.me()])
      if (actor.principal !== ctx.me.principal) return "this handle's profiles are principals of their own, so none is its principal's actor"
      // What its principal made as itself isn't the profile's: not to give itself, to hold, or to cancel.
      await rejects(profile.tasks.assign(principals.id, actor.actor), 403, 'task_not_owned', "assigning its principal's task to itself, by a profile")
      await rejects(profile.tasks.block(principals.id, 'conformance: not its own'), 403, 'task_not_owned', "holding its principal's task, by a profile")
      await rejects(profile.tasks.cancel(principals.id, 'conformance: not its own'), 403, 'task_not_owned', "canceling its principal's task, by a profile")
      await rejects(profile.tasks.needs(principals.id, []), 403, 'task_not_owned', "changing what its principal's task needs, by a profile")
      // What it made is its own to change, and no other profile's, which shares its credential.
      const { task: own } = await profile.tasks.create(ctx.channel, { text: "conformance: a profile's own task", labels: ctx.labels, noSync: true })
      ctx.posted.push(own.id)
      same(own.task?.owner, ctx.me.principal, "who owns a profile's task: its principal")
      same(own.task?.by, actor.actor, "the actor a profile's task was made as")
      same((await ctx.board.thread(own.id)).message.task?.by, actor.actor, "the actor a profile's task was made as, read as its thread")
      same(principals.task?.by, ctx.me.principal, "the actor its principal's task was made as")
      same((await profile.tasks.assign(own.id, actor.actor)).task?.for, actor.actor, "who a profile's own task is for, once it assigns it")
      await rejects(sibling.tasks.assign(own.id, other.actor), 403, 'task_not_owned', "assigning a profile's task to itself, by another profile of its principal")
      await rejects(sibling.tasks.cancel(own.id, 'conformance: not its own'), 403, 'task_not_owned', "canceling a profile's task, by another profile of its principal")
      same((await ctx.board.thread(own.id)).message.task?.for, actor.actor, "who a profile's task is for, after another profile's refused changes")
      // Its principal, as itself, changes any of its profiles' tasks, and the one it made.
      same((await principal.tasks.assign(own.id, null)).task?.for, null, "who a profile's task is for, once its principal gives it back to the pool")
      same((await principal.tasks.cancel(own.id, 'conformance: done checking')).task?.state, 'canceled', "a profile's task, once its principal cancels it")
      same((await principal.tasks.assign(principals.id, actor.actor)).task?.for, actor.actor, "who its principal's task is for, once its principal assigns it")
      // The same owner decides whose edit changes what a task says: a profile's thread, made a task by its principal, is held when the profile edits it.
      const thread = await profile.post(ctx.channel, { text: "conformance: a profile's thread, made a task by its principal", labels: ctx.labels, noSync: true })
      ctx.posted.push(thread.id)
      await principal.tasks.create({ re: thread.id })
      await profile.edit(thread.id, "conformance: a profile's thread, edited by it")
      const edited = (await ctx.board.thread(thread.id)).message
      same(edited.task?.state, 'blocked', "its principal's task, once the profile that wrote its root edited it")
      same(edited.task?.blocked?.kind, 'edited', 'what it is held for')
    },
  },
  {
    group: 'tasks',
    name: 'takes label in its channel to claim a task: a caller narrowed to reading and posting claims none',
    run: async (ctx) => {
      // A board that keeps no tasks says so first, whatever the run can send.
      const { task: root } = await task(ctx, 'conformance: a task to claim without label')
      if (!ctx.withCan) return NO_CAN
      const narrowed = ctx.withCan(`${ctx.channel}=read,post`)
      same((await narrowed.thread(root.id)).message.task?.state, 'ready', 'the task, as a caller narrowed to reading and posting reads it')
      await rejects(narrowed.tasks.claim(root.id), 403, 'forbidden', 'a claim by a caller without label in its channel')
      await rejects(narrowed.tasks.claim({ channel: ctx.channel, label: ctx.labels }), 403, 'forbidden', 'a claim of the next ready task by a caller without label in that channel')
      same(await taskState(ctx, root.id), 'ready', 'the task, after the refused claims')
    },
  },
  {
    group: 'tasks',
    name: "takes read in a prerequisite's channel to wait for it: a caller narrowed out of it makes no task that needs it",
    run: async (ctx) => {
      const beside = besideOf(ctx)
      // A board that keeps no tasks says so first, whatever the run can send.
      const made = await taskBeside(ctx, "conformance: a prerequisite its caller can't read")
      if (!ctx.withCan) return NO_CAN
      if (!made) return `this token can't post in ${beside}`
      const unread = made.task
      const { task: read } = await task(ctx, 'conformance: a prerequisite its caller reads')
      // It posts on the whole board and reads only the channel: the prerequisite's is closed to it.
      const narrowed = ctx.withCan(`*=post;${ctx.channel}=read,post,label`)
      const starting = narrowed.tasks.create(ctx.channel, { text: "conformance: needs a task its caller can't read", labels: ctx.labels, noSync: true, needs: [unread.id] }).then((started) => {
        ctx.posted.push(started.task.id)
        return started
      })
      await rejects(starting, 400, 'invalid_needs', "a task that needs one its caller can't read")
      const plain = await narrowed.post(ctx.channel, { text: "conformance: a thread that would need a task its caller can't read", labels: ctx.labels, noSync: true })
      ctx.posted.push(plain.id)
      await rejects(narrowed.tasks.create({ re: plain.id }, { needs: [unread.id] }), 400, 'invalid_needs', "making a thread a task that needs one its caller can't read")
      same((await ctx.board.thread(plain.id)).message.task, undefined, 'the thread, after it was refused as a task')
      alike((await ctx.board.tasks.list({ needs: unread.id })).tasks.map((listed) => listed.message.id), [], "the tasks that wait for the one its caller can't read")
      // One it reads is a prerequisite, as for anyone.
      const waits = await narrowed.tasks.create(ctx.channel, { text: 'conformance: needs a task its caller reads', labels: ctx.labels, noSync: true, needs: [read.id] })
      ctx.posted.push(waits.task.id)
      same(waits.task.task?.state, 'waiting', 'a task that needs one its caller reads')
    },
  },
  {
    group: 'tasks',
    name: 'claims the oldest ready task in a channel or its subtree that has the labels asked for, and waits for one',
    run: async (ctx) => {
      const queue = { ...ctx.labels, queue: `q${ctx.labels.conformance}` }
      const { task: older } = await task(ctx, 'conformance: the older of two', { labels: queue })
      const { task: newer } = await task(ctx, 'conformance: the newer of two', { labels: queue })
      same(await ctx.board.tasks.claim({ channel: ctx.channel, label: { ...queue, queue: 'no-such-queue' } }), null, 'a claim for labels no ready task has')
      // The channel is under its own subtree.
      const first = await ctx.board.tasks.claim({ channel: `${ctx.channel}/`, label: queue, lease: 60 })
      same(first?.task.id, older.id, 'the task claimed first, in the subtree')
      const second = await ctx.board.tasks.claim({ channel: ctx.channel, label: queue, lease: 60 })
      same(second?.task.id, newer.id, 'the task claimed next, in the channel')
      same(await ctx.board.tasks.claim({ channel: ctx.channel, label: queue }), null, 'a claim once both are held')
      // One that waits gets the task released while it does.
      const waiting = ctx.board.tasks.claim({ channel: ctx.channel, label: queue, wait: 10, lease: 60 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await first!.release()
      const got = await waiting
      same(got?.task.id, older.id, 'the task a waiting claim got')
      await got!.release()
      await second!.release()
    },
  },
  {
    group: 'tasks',
    name: 'shows a feed that filters on board.task=ready a task becoming ready and being claimed, and never a token',
    run: async (ctx) => {
      const { task: first } = await task(ctx, 'conformance: a prerequisite to watch')
      const { task: second } = await task(ctx, 'conformance: a task to watch become ready', { needs: [first.id] })
      const label = [`conformance=${ctx.labels.conformance}`, 'board.task=ready']
      let { cursor } = await ctx.board.poll({ channel: ctx.channel, label })
      const seen: Awaited<ReturnType<Board['poll']>>['events'] = []
      const until = async (found: () => boolean, what: string) => {
        for (const deadline = Date.now() + 10_000; !found(); ) {
          if (Date.now() >= deadline) throw new Mismatch(`${what}, within a few seconds`)
          const page = await ctx.board.poll({ channel: ctx.channel, label, after: cursor, wait: 2 })
          seen.push(...page.events)
          cursor = page.cursor
        }
      }
      await (await ctx.board.tasks.claim(first.id, { lease: 60 })).complete()
      await until(() => seen.some((event) => event.type === 'task.ready' && event.message?.id === second.id), 'the feed should show the task become ready')
      const claim = await ctx.board.tasks.claim(second.id, { lease: 60 })
      await until(() => seen.some((event) => event.type === 'task.claimed' && event.message?.id === second.id), 'the feed should show the task being claimed')
      const claimed = seen.find((event) => event.type === 'task.claimed' && event.message?.id === second.id)!
      same(claimed.message?.task?.state, 'claimed', "the task in its claim's event")
      check(!('token' in claimed.payload) && !show(seen).includes(claim.token), "the feed shouldn't show a claim's token")
      await claim.release()
    },
  },
  {
    group: 'tasks',
    name: 'keeps labels under board. its own: a label write or a post that sets one is refused',
    run: async (ctx) => {
      const { task: root } = await task(ctx, 'conformance: a task whose label is the board\'s')
      await rejects(ctx.board.label(root.id, { set: { 'board.task': 'completed' } }), 400, 'reserved_label', 'a label write that sets board.task')
      await rejects(ctx.board.label(root.id, { unset: ['board.task'] }), 400, 'reserved_label', 'a label write that unsets board.task')
      const posting = ctx.board.post(ctx.channel, { text: 'conformance: a post that names itself ready', labels: { ...ctx.labels, 'board.task': 'ready' }, noSync: true }).then((message) => {
        ctx.posted.push(message.id)
        return message
      })
      await rejects(posting, 400, 'reserved_label', 'a post whose labels set board.task')
      same(await taskState(ctx, root.id), 'ready', 'the task, after the refused writes')
      // It reads like any label: a write may be conditional on it.
      await ctx.board.label(root.id, { set: { seen: 'yes' }, if: { 'board.task': 'ready' } })
      same((await ctx.board.thread(root.id)).message.labels.seen, 'yes', "a label set while board.task is what the write's `if` says")
      await rejects(ctx.board.label(root.id, { set: { seen: 'no' }, if: { 'board.task': null } }), 409, 'label_conflict', 'a label write that holds on there being no task, on a task')
      await rejects(ctx.board.label(root.id, { set: { seen: 'no' }, if: { 'board.task': 'claimed' } }), 409, 'label_conflict', "a label write that holds on a state the task isn't in")
      same((await ctx.board.thread(root.id)).message.labels.seen, 'yes', 'the label, after the writes its `if` refused')
    },
  },
  {
    group: 'tasks',
    name: 'holds a task when anyone but its owner edits its root, which ends its claim',
    run: async (ctx) => {
      // A board that keeps no tasks says so before anything is imported.
      await ctx.board.tasks.list({ channel: ctx.channel, limit: 1 })
      // The run owns every task it makes and writes every root it posts, so the other author is a
      // platform's: a thread imported as its user, made a task, then edited on the platform.
      const key = SYNC_KEY
      const thread = `${key}:${ctx.labels.conformance}:task`
      const author = { id: `${key}:user:${ctx.labels.conformance}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      const origin = { thread, message: '1' }
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      let id: string | null
      try {
        ;({ message: id } = await ctx.board.syncImport({
          op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform, to make a task', labels: ctx.labels, noSync: true,
          origin: { channel: `${key}:${ctx.labels.conformance}`, thread, subthread: null, message: '1', context: null },
        }))
      } catch (error) {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
        if (error instanceof BoardError && error.status === 403) return `this token can't sync in ${ctx.channel}`
        throw error
      }
      try {
        isRef(id, "an import's message")
        await ctx.board.tasks.create({ re: id! })
        const claim = await ctx.board.tasks.claim(id!, { lease: 60 })
        await ctx.board.syncImport({ op: 'edit', author, from: key, origin, text: 'conformance: edited on the platform' })
        const edited = (await ctx.board.thread(id!)).message
        same(edited.text, 'conformance: edited on the platform', "the root's text, once edited")
        same(edited.task?.state, 'blocked', 'the task, once its root was edited by someone else')
        same(edited.task?.blocked?.kind, 'edited', 'what it is held for')
        await rejects(claim.complete(), 409, 'claim_lost', "the claim's complete, once the edit held the task")
        same((await ctx.board.tasks.unblock(id!)).task?.state, 'ready', 'the task, once its owner unblocked it')
      } finally {
        // Its author is the platform user: only an import can take it down.
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin }).catch(() => {})
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'grants',
    name: 'grants a principal, lists it, and revokes it',
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const grant = await make(grantFor(ctx))
        isRef(grant.id, "a grant's id")
        const [project] = grant.principals
        check(
          grant.principals.length === 1 && project?.kind === 'project' && (project.projectId === ctx.principals.project || project.name === ctx.principals.project),
          `the grant's principals: expected the project ${ctx.principals.project}, got ${show(grant.principals)}`,
        )
        alike(project.environments, ['preview'], "the project's environments")
        alike(grant.can, { [`${subtreeOf(ctx)}ci/`]: ['post'] }, "the grant's can")
        same((await ctx.board.grants()).filter((listed) => listed.id === grant.id).length, 1, 'grants listing it')
        same((await ctx.board.revokeGrant(grant.id)).revoked, true, 'revoking it')
        same((await ctx.board.revokeGrant(grant.id)).revoked, false, 'revoking it again')
        check(!(await ctx.board.grants()).some((listed) => listed.id === grant.id), "grants shouldn't list it once it's revoked")
      }),
  },
  {
    group: 'grants',
    name: 'makes another grant for the same principals, and changes one by its ID',
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const first = await make(grantFor(ctx))
        const again = await make(grantFor(ctx))
        check(again.id !== first.id, `the same principals again should be another grant, got ${again.id} twice`)
        const other = granteeOf(ctx)
        const ci = `${subtreeOf(ctx)}ci/`
        // A board that looks names up and has none for the app or repository skips the rest.
        const update = async (change: Parameters<Board['updateGrant']>[1]) => {
          try {
            return await ctx.board.updateGrant(first.id, change)
          } catch (error) {
            throw unnamed(error) ?? error
          }
        }
        // The project again joins the one it names: its environments together.
        const added = await update({ add: [other, projectFor(ctx, ['production'])], can: { [ci]: ['read', 'post'] } })
        same(added.grant.id, first.id, "the updated grant's id")
        alike(added.grant.principals.map((principal) => principal.kind), ['project', other.kind], `principals after adding ${other.kind === 'app' ? 'an app' : 'a repository'}, and the project again`)
        const project = added.grant.principals[0]
        alike(sortedOf(project?.kind === 'project' ? project.environments : undefined), sortedOf(['preview', 'production']), "the project's environments, after adding it again")
        alike(added.grant.can, { [ci]: ['read', 'post'] }, "the updated grant's can")
        // A project to remove is the project, whatever its environments.
        const removed = await update({ remove: [{ kind: 'project', project: ctx.principals.project }] })
        alike(removed.grant.principals.map((principal) => principal.kind), [other.kind], 'principals after removing the project')
        await rejects(update({ remove: [{ kind: 'project', project: ctx.principals.project }] }), 400, 'not_in_grant', 'removing a principal the grant no longer names')
        await rejects(update({ remove: [other] }), 400, 'grant_empty', 'removing the last principal')
        await rejects(ctx.board.updateGrant(`${first.id}0`, { can: { [ci]: ['read'] } }), 404, 'grant_not_found', 'updating a grant that was never made')
      }),
  },
  {
    group: 'grants',
    name: "keeps a grant's can as written, a pattern with no permissions included",
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const subtree = subtreeOf(ctx)
        const can = { [subtree]: ['read'], [`${subtree}hidden/`]: [] } as const
        const grant = await make({ principals: [projectFor(ctx, ['production', 'preview'])], can })
        alike(grant.can, can, "the grant's can")
        const listed = (await ctx.board.grants()).find((found) => found.id === grant.id)
        alike(listed?.can, can, "the listed grant's can")
        const project = listed?.principals[0]
        alike(sortedOf(project?.kind === 'project' ? project.environments : undefined), sortedOf(['preview', 'production']), "the project's environments")
      }),
  },
  {
    group: 'grants',
    name: 'lets the most specific pattern decide, then the closest principal there, and adds up ties',
    run: (ctx) =>
      withGrants(ctx, async ({ make, keep }) => {
        const subtree = subtreeOf(ctx)
        const closed = `${subtree}closed/`
        const channel = `${closed}thread`
        const project = projectFor(ctx, ['production'])
        const who = { project: ctx.principals.project, environment: 'production' }
        await keep(closed)
        await make({ principals: [project], can: { [subtree]: ['read', 'post'] } })
        const lock = await make({ principals: [{ kind: 'everyone' }], can: { [closed]: [] } })
        // A grant naming it on the subtree doesn't help where a more specific one closes it.
        const shut = await explain(ctx, channel, who)
        same(shut.pattern, closed, `the pattern that decides ${channel}`)
        check(shut.over.includes(subtree), `${closed} should win over ${subtree}, got ${show(shut.over)}`)
        same(shut.level, 'everyone', `the level that decides ${channel}`)
        check(shut.grants.some((grant) => grant.id === lock.id), `everyone's grant should decide, got ${show(shut.grants.map((grant) => grant.id))}`)
        alike(shut.can, [], `what the project may do in ${channel}`)
        const reads = await make({ principals: [project], can: { [closed]: ['read'] } })
        const posts = await make({ principals: [project], can: { [closed]: ['post'] } })
        const open = await explain(ctx, channel, who)
        same(open.level, 'principal', `the level that decides ${channel} once grants name the project there`)
        alike(sortedOf(open.grants.map((grant) => grant.id)), sortedOf([reads.id, posts.id]), 'the grants that decide, which add up')
        alike(open.can, ['read', 'post'], 'what they give together')
      }),
  },
  {
    group: 'grants',
    name: 'lets everyone narrow what something else lets in, and lets no one in itself',
    run: (ctx) =>
      withGrants(ctx, async ({ make, keep }) => {
        const subtree = subtreeOf(ctx)
        const inner = `${subtree}inner/`
        const channel = `${inner}thread`
        await keep(inner)
        await make({ principals: [{ kind: 'everyone' }], can: { [inner]: ['read'] } })
        const outsider = await explain(ctx, channel, { github: ctx.principals.repository })
        same(outsider.pattern, null, "the pattern that decides for a repository's runs nothing else lets in")
        alike(outsider.can, [], "what everyone's grant gives them")
        if (ctx.team === null) return 'this board names no team, so no project is on it for all-projects'
        const who = { project: ctx.principals.project, environment: 'production' }
        const every = { kind: 'all-projects' as const, environments: ['production'] }
        // A grant for every project names this run too, when it's one: it keeps manage here to revoke it.
        await keep(subtree)
        await make({ principals: [every], can: { [subtree]: ['read', 'post'] } })
        const narrowed = await explain(ctx, channel, who)
        same(narrowed.level, 'everyone', `the level that decides ${channel} for a project every project's grant lets in`)
        alike(narrowed.can, ['read'], 'what it may do there')
        const group = await make({ principals: [every], can: { [inner]: ['post'] } })
        const widened = await explain(ctx, channel, who)
        same(widened.level, 'group', `the level that decides ${channel} once every project's grant names it`)
        alike(widened.grants.map((grant) => grant.id), [group.id], 'the grant that decides')
        alike(widened.can, ['post'], 'what it gives, the closer level alone')
      }),
  },
  {
    group: 'grants',
    name: 'caps a person by their team role, so a viewer reads but neither posts nor manages',
    run: (ctx) => {
      const { viewer } = ctx.principals
      if (viewer === null) return Promise.resolve('name a viewer in principals to check it: a board without team roles caps no one')
      return withGrants(ctx, async ({ make }) => {
        const subtree = subtreeOf(ctx)
        await make({ principals: [viewer.includes('@') ? { kind: 'user', email: viewer } : { kind: 'user', userId: viewer }], can: { [subtree]: 'all' } })
        const explained = await explain(ctx, `${subtree}thread`, { user: viewer })
        same(explained.level, 'principal', `the level that decides ${subtree}thread for the viewer`)
        check(explained.capped !== null, `the viewer's role should cap what the grant gives, got capped ${show(explained.capped)}`)
        // What a viewer may do is the team's to say; reading, and not posting or managing, is what's checked.
        check(explained.can.includes('read') && !explained.can.includes('post') && !explained.can.includes('manage'), `what a viewer may do with a grant of all: expected read, and neither post nor manage, got ${show(explained.can)}`)
      })
    },
  },
  {
    group: 'grants',
    name: 'names an app by its slug or client ID, keeps it by client ID, and every app as a group',
    run: (ctx) => {
      const { app } = ctx.principals
      if (app === null) return Promise.resolve('name an app in principals to check it: a local board has no apps')
      return withGrants(ctx, async ({ make, keep }) => {
        const apps = `${subtreeOf(ctx)}apps/`
        // Every app there would be this run too, if it's an app: kept in, so it can revoke the grant after.
        if (ctx.me.principal.startsWith('vercel:app:')) await keep(apps)
        const grant = await make({ principals: [{ kind: 'app', app }], can: { [apps]: ['post'] } })
        const [named] = grant.principals
        check(
          grant.principals.length === 1 && named?.kind === 'app' && (named.clientId === app || named.name === app),
          `the grant's principals: expected the app ${app}, got ${show(grant.principals)}`,
        )
        const swapped = await ctx.board.updateGrant(grant.id, { add: [{ kind: 'all-apps' }], remove: [{ kind: 'app', app }] })
        alike(swapped.grant.principals, [{ kind: 'all-apps' }], 'principals after adding every app and removing the one')
      })
    },
  },
  {
    group: 'grants',
    name: 'takes manage at each pattern a grant names to change it, and at * to list them',
    run: (ctx) =>
      withGrants(ctx, async ({ make, deny, narrow }) => {
        const subtree = subtreeOf(ctx)
        const inner = `${subtree}inner/`
        const poster = narrow({ '*': ['read', 'post'] })
        // Whether this run may change grants at all, before it asks a narrowed caller to.
        const probe = await make(grantFor(ctx))
        await deny(poster, grantFor(ctx), 'a grant made without manage')
        await refused(poster.updateGrant(probe.id, { can: { [`${subtree}ci/`]: ['read'] } }), 403, 'an update without manage')
        await refused(poster.revokeGrant(probe.id), 403, 'a revoke without manage')
        await refused(poster.grants(), 403, 'listing grants without manage at *')
        await refused(poster.explain(`${subtree}thread`, { project: ctx.principals.project }), 403, "explaining a principal's access without manage at *")
        alike((await poster.explain(`${subtree}thread`)).grants, [], 'which grants decide, for a caller that may not list them')
        const manager = narrow({ '*': ['read', 'post', 'react', 'label', 'sync'], [inner]: 'all' })
        const grant = await make({ principals: [projectFor(ctx)], can: { [inner]: ['read'] } }, manager)
        await deny(manager, { principals: [projectFor(ctx)], can: { [subtree]: ['read'] } }, `a grant on ${subtree} made with manage only at ${inner}`)
        await refused(manager.updateGrant(grant.id, { can: { [subtree]: ['read'] } }), 403, `moving a grant to ${subtree} with manage only at ${inner}`)
        await refused(manager.grants(), 403, `listing grants with manage only at ${inner}`)
        same((await manager.revokeGrant(grant.id)).revoked, true, `revoking a grant on ${inner} with manage there`)
      }),
  },
  {
    group: 'grants',
    name: "lets no caller narrowed with x-board-can grant past its can, even where everyone's grant closes it",
    run: (ctx) =>
      withGrants(ctx, async ({ make, deny, narrow, keep }) => {
        const subtree = subtreeOf(ctx)
        const secret = `${subtree}secret/`
        const run = granteeOf(ctx)
        const narrowed = narrow({ '*': 'all', [secret]: [] })
        await deny(narrowed, { principals: [run], can: { [subtree]: ['read'] } }, `a grant on ${subtree} from a caller narrowed out of ${secret}`)
        // A lock there binds whoever it names as much as the caller, until it's lifted: its own limit still counts.
        await keep(secret)
        await make({ principals: [{ kind: 'everyone' }], can: { [secret]: [] } })
        await deny(narrowed, { principals: [run], can: { [subtree]: ['read'] } }, `a grant on ${subtree} from a caller narrowed out of ${secret}, once everyone is too`)
        // What it may manage, it grants.
        await make({ principals: [run], can: { [`${subtree}ci/`]: ['post'] } }, narrowed)
      }),
  },
  {
    group: 'grants',
    name: 'lets no caller narrowed with x-board-can let anyone in where everyone gets more than it has',
    run: (ctx) =>
      withGrants(ctx, async ({ make, deny, narrow, keep }) => {
        const subtree = subtreeOf(ctx)
        const open = `${subtree}open/`
        const narrowed = narrow({ '*': 'all', [open]: [] })
        await keep(open)
        await make({ principals: [{ kind: 'everyone' }], can: { [open]: ['read'] } })
        // Anyone it lets in, anywhere, would read open/ through everyone's grant.
        await deny(narrowed, { principals: [granteeOf(ctx)], can: { [`${subtree}ci/`]: ['post'] } }, `a grant from a caller narrowed out of ${open}, which everyone reads`)
      }),
  },
  {
    group: 'grants',
    name: "refuses a grant its maker couldn't take back, unless it says lockMeOut",
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const pattern = `${subtreeOf(ctx)}lockout/`
        // A board that takes no lockMeOut refuses this one, as grant bodies are strict, which stops
        // the check here: it would make the lock below, and this run couldn't revoke it afterwards.
        // One that drops keys it doesn't know gets past this, and the run's own handle checks a
        // body before the board sees it, so the kit can't ask it with a key that's wrong.
        await make(grantFor(ctx), undefined, { lockMeOut: true }).catch((error: unknown) => {
          if (error instanceof BoardError && error.status === 400) throw new Mismatch(`a grant that says lockMeOut: expected it made, got ${error.status} ${error.code}`)
          throw error
        })
        const before = (await ctx.board.grants()).length
        let made: GrantView
        try {
          made = (await ctx.board.createGrant({ principals: [{ kind: 'everyone' }], can: { [pattern]: [] } })).grant
        } catch (error) {
          if (!(error instanceof BoardError) || error.status !== 409 || error.code !== 'grant_lockout')
            throw new Mismatch(`closing ${pattern} to everyone, this run included: expected 409 grant_lockout, got ${error instanceof BoardError ? `${error.status} ${error.code}` : messageOf(error)}`)
          same((await ctx.board.grants()).length, before, 'how many grants there are after the one refused')
          return
        }
        // It was made: this run owns the board, which nothing locks out, or the board let it lock itself out.
        await ctx.board.revokeGrant(made.id).catch((error: unknown) => {
          throw new Mismatch(`closing ${pattern} to everyone, this run included: expected 409 grant_lockout, and the board made ${made.id}, which this run can't revoke now (${messageOf(error)})`)
        })
        return "nothing locks this run out of a channel, so no grant it makes is a lockout: it owns the board, or it's the board's own code"
      }),
  },
  {
    group: 'grants',
    name: 'makes several grants in one write, or none of them, a lock with the grant that keeps its maker in',
    run: (ctx) =>
      withGrants(ctx, async ({ make, makeAll, self }) => {
        const subtree = subtreeOf(ctx)
        const pattern = `${subtree}batch/`
        const lock = { principals: [{ kind: 'everyone' as const }], can: { [pattern]: [] } }
        const me = self()
        // Whether this run may change grants at all, before a refusal of several could mean anything else.
        await make({ principals: [projectFor(ctx)], can: { [`${subtree}batch/ci/`]: ['read'] } })
        // The lock first: made one at a time, the grant that keeps this run in would come too late.
        const made = await makeAll(me ? [lock, { principals: [me], can: { [pattern]: 'all' } }, grantFor(ctx)] : [lock, grantFor(ctx)])
        alike(made.map((grant) => grant.principals[0]?.kind), me ? ['everyone', me.kind, 'project'] : ['everyone', 'project'], "the batch's grants, in the order given")
        check(new Set(made.map((grant) => grant.id)).size === made.length, `each of a batch's grants should have its own ID, got ${show(made.map((grant) => grant.id))}`)
        const listed = (await ctx.board.grants()).map((grant) => grant.id)
        check(made.every((grant) => listed.includes(grant.id)), `grants should list each one a batch made, got ${show(listed)}`)
        // One the board refuses, and none of them is made.
        await rejects(ctx.board.createGrants([grantFor(ctx), { principals: [projectFor(ctx)], can: { [`${subtree}*/ci`]: ['post'] } }]), 400, 'invalid_grant', "a batch with a grant whose pattern isn't one")
        const after = (await ctx.board.grants()).map((grant) => grant.id)
        // What a board made of a batch it refused goes with the rest: this run made it.
        for (const id of after) if (!listed.includes(id)) await ctx.board.revokeGrant(id)
        alike(after, listed, 'the grants after a batch that was refused')
      }),
  },
  {
    group: 'grants',
    name: 'lets a member grant on a pattern after a lock under it',
    // A skip, saying why: the run would be the member, shut out under the lock, and only the
    // board's owner or a grant on the run there, which would keep it in, could lift the lock after.
    run: async () => "a run can't be shut out by a lock and lift it afterwards: the board's own tests check it",
  },
  {
    group: 'grants',
    name: 'lets a project on another team in, in its environments',
    // A skip, saying why, so a report shows it's left out on purpose.
    run: async () => "grants across teams aren't specified yet: what a project on another team needs, and what all-projects means for one, comes later",
  },
  {
    group: 'schemas',
    name: 'lists the built-in schemas first, and reads a schema by its ID',
    run: async (ctx) => {
      const schemas = await ctx.board.schemas()
      const own = schemas.findIndex((schema) => !schema.builtIn)
      check(own === -1 || schemas.slice(own).every((schema) => !schema.builtIn), `schemas should list the built-ins first, got ${show(schemas.map((schema) => schema.id))}`)
      const commit = schemas.find((schema) => schema.id === 'git-commit@1')
      check(commit, `schemas should list the built-in git-commit@1, got ${show(schemas.map((schema) => schema.id))}`)
      alike({ name: commit.name, version: commit.version, builtIn: commit.builtIn, by: commit.by, at: commit.at }, { name: 'git-commit', version: 1, builtIn: true, by: null, at: null }, 'the built-in git-commit@1')
      check(commit.schema.type === 'object', `a schema's definition should describe an object, got ${show(commit.schema)}`)
      same(canonical(await ctx.board.schema('git-commit@1')), canonical(commit), 'git-commit@1, read by its ID')
      await rejects(ctx.board.schema('conformance-none@1'), 404, 'schema_not_found', 'reading a version no one registered')
      await rejects(ctx.board.schema('Not A Schema'), 400, 'invalid_schema_id', 'reading an ID that names no schema')
    },
  },
  {
    group: 'schemas',
    name: 'registers a schema version once: the same definition again changes nothing, and another is refused',
    run: async (ctx) => {
      const registered = await register(ctx)
      if ('skip' in registered) return registered.skip
      const { schema, created } = registered.made
      check(typeof created === 'boolean', `created should say whether this made it, got ${show(created)}`)
      alike(
        { id: schema.id, name: schema.name, version: schema.version, description: schema.description, builtIn: schema.builtIn },
        { id: 'conformance@1', name: SCHEMA.name, version: SCHEMA.version, description: SCHEMA.description, builtIn: false },
        'the schema it registered',
      )
      same(canonical(schema.schema), canonical(SCHEMA.schema), "the schema's definition, as it was sent")
      check(typeof schema.by === 'string' && schema.by.length > 0, `a registered schema should say who registered it, got ${show(schema.by)}`)
      check(typeof schema.at === 'string' && !Number.isNaN(Date.parse(schema.at)), `a registered schema should say when, got ${show(schema.at)}`)
      // The same definition, however its keys are ordered, is the same version.
      const again = await ctx.board.createSchema({ ...SCHEMA, schema: reversed(SCHEMA.schema) as Record<string, unknown> })
      same(again.created, false, 'whether registering the same definition again made one')
      same(canonical(again.schema), canonical(schema), 'the schema, registered again')
      await rejects(ctx.board.createSchema({ ...SCHEMA, schema: { type: 'object', required: ['run'], properties: { run: { type: 'string' } } } }), 409, 'schema_immutable', 'another definition for a version that is there')
      await rejects(ctx.board.createSchema({ ...SCHEMA, description: 'Something else.' }), 409, 'schema_immutable', 'another description for a version that is there')
      same(canonical(await ctx.board.schema(schema.id)), canonical(schema), 'the schema, read by its ID')
      const listed = (await ctx.board.schemas()).filter((found) => found.id === schema.id)
      same(listed.length, 1, `how many times schemas lists ${schema.id}`)
    },
  },
  {
    group: 'schemas',
    name: "refuses a built-in's name, and a definition it couldn't check a value against",
    run: async (ctx) => {
      // Refused before anything is kept, so a board that takes one keeps a version named for this check alone.
      const attempt = (schema: Record<string, unknown>, name = 'conformance-refused', version = 1) => ctx.board.createSchema({ name, version, schema })
      const reserved = await attempt({ type: 'object' }, 'git-commit', 2).then(
        () => null,
        (error: unknown) => error,
      )
      if (reserved instanceof BoardError && reserved.status === 403) return "this token can't register schemas"
      if (!(reserved instanceof BoardError && reserved.status === 409 && reserved.code === 'reserved_schema'))
        throw new Mismatch(`a version of the built-in git-commit: expected 409 reserved_schema, ${reserved === null ? 'and it registered one' : `got ${reserved instanceof BoardError ? `${reserved.status} ${reserved.code}` : String(reserved)}`}`)
      await rejects(attempt({ type: 'string' }), 400, 'invalid_schema', 'a schema that describes no object')
      await rejects(attempt({ type: 'object', properties: { next: { $ref: '#' } } }), 400, 'invalid_schema', 'a schema with a $ref')
      await rejects(attempt({ type: 'object', properties: { id: { type: 'string', pattern: '^(a+)+$' } } }), 400, 'invalid_schema', 'a schema with a pattern')
      await rejects(attempt({ type: 'object', properties: { ids: { type: 'array', uniqueItems: true } } }), 400, 'invalid_schema', 'a schema with uniqueItems')
    },
  },
  {
    group: 'schemas',
    name: 'carries a block in a message, checked against the schema its fence names',
    run: async (ctx) => {
      // The schema this run registers, or one an earlier run did: anyone who posts may use it.
      const registered = await register(ctx)
      if ('skip' in registered && !(await ctx.board.schema('conformance@1').then(() => true, () => false))) return `${registered.skip}, and none registered conformance@1 before it`
      const data = { run: ctx.labels.conformance, outcome: 'passed', checks: [{ name: 'a block', skipped: false }] }
      const text = `conformance: a block among prose\n\n${block('conformance@1', data)}\n\nand after it`
      const message = await post(ctx, text)
      same(message.text, text, "the post's text, as it was written")
      same(canonical(message.blocks), canonical([{ schema: 'conformance', version: 1, data }]), "the post's blocks")
      same(canonical((await ctx.board.thread(message.id)).message.blocks), canonical(message.blocks), "the post's blocks, read back")
      // A message that is only its block, and one that only shows one, in a longer fence.
      const alone = await post(ctx, block('conformance@1', data))
      same(canonical(alone.blocks), canonical([{ schema: 'conformance', version: 1, data }]), 'the blocks of a message that is only one')
      const shown = await post(ctx, `conformance: a block shown, not carried\n\n\`\`\`\`\n${block('conformance@1', { outcome: 'maybe' })}\n\`\`\`\``)
      same(canonical(shown.blocks), '[]', 'the blocks of a message that shows one inside a longer fence')
      same(canonical((await post(ctx, 'conformance: no block')).blocks), '[]', 'the blocks of a message with none')
      // One that doesn't match, or names a schema no one registered, isn't written.
      const refusedPost = (body: string) =>
        ctx.board.post(ctx.channel, { text: body, labels: ctx.labels, noSync: true }).then((wrong) => {
          ctx.posted.push(wrong.id)
          return wrong
        })
      await rejects(refusedPost(block('conformance@1', { run: ctx.labels.conformance, outcome: 'maybe' })), 400, 'invalid_block', "a post whose block doesn't match its schema")
      await rejects(refusedPost(block('conformance-none@1', { run: ctx.labels.conformance })), 400, 'schema_not_found', 'a post whose block names a schema no one registered')
      await rejects(ctx.board.edit(alone.id, block('conformance@1', { outcome: 'passed' })), 400, 'invalid_block', "an edit whose block doesn't match its schema")
      same(canonical((await ctx.board.thread(alone.id)).message.blocks), canonical(alone.blocks), 'the blocks of a message after an edit that was refused')
    },
  },
  {
    group: 'schemas',
    name: 'refuses a caller narrowed with x-board-can a schema, and lets it read them',
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const narrowed = ctx.withCan(`${ctx.channel}=read,post`)
      check((await narrowed.schemas()).some((schema) => schema.id === 'git-commit@1'), 'a caller narrowed to a channel should read the schemas')
      // The one this run registers, so a board that takes it keeps nothing new.
      await narrowedOut(narrowed.createSchema(SCHEMA), 'registering a schema')
    },
  },
  {
    group: 'attachments',
    name: 'takes a file, posts it, and gives it back',
    run: async (ctx) => {
      const bytes = new TextEncoder().encode(`conformance ${ctx.labels.conformance}\n`)
      const attachment = await ctx.board.upload({ data: bytes, name: 'conformance.txt', type: 'text/plain' })
      const message = await post(ctx, 'conformance: a file', { attachments: [attachment.id] })
      check(message.attachments.some((a) => a.id === attachment.id), 'the post should carry the file')
      const response = await ctx.board.download(attachment.id)
      same(new TextDecoder().decode(await response.arrayBuffer()), new TextDecoder().decode(bytes), "the file's bytes")
    },
  },
  {
    group: 'attachments',
    name: 'refuses a name that would download as a dotfile',
    run: async (ctx) => {
      const bytes = new TextEncoder().encode(`conformance ${ctx.labels.conformance}\n`)
      try {
        await ctx.board.upload({ data: bytes, name: '.conformance', type: 'text/plain' })
      } catch (error) {
        // A board that keeps no files says so first, and the kit reports its 501 as not kept here.
        if (error instanceof BoardError && error.status === 501) throw error
        if (error instanceof BoardError && error.status === 400 && error.code === 'invalid_attachment') return
        throw new Mismatch(`a dotfile name: expected 400 invalid_attachment, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      throw new Mismatch('a dotfile name: expected 400 invalid_attachment, and it succeeded')
    },
  },
  {
    group: 'attachments',
    name: 'starts a task with a file, which its root carries',
    run: async (ctx) => {
      // A board that keeps no tasks says so before anything is uploaded.
      await ctx.board.tasks.list({ channel: ctx.channel, limit: 1 })
      const bytes = new TextEncoder().encode(`conformance ${ctx.labels.conformance}: a task's file\n`)
      const attachment = await ctx.board.upload({ data: bytes, name: 'conformance-task.txt', type: 'text/plain' })
      const { task: root } = await task(ctx, 'conformance: a task with a file', { attachments: [attachment.id] })
      check(root.attachments.some((a) => a.id === attachment.id), "the task's root should carry the file")
      same(root.task?.state, 'ready', "the task's state")
      check((await ctx.board.thread(root.id)).message.attachments.some((a) => a.id === attachment.id), 'the task, read as its thread, should carry the file')
    },
  },
  {
    group: 'watchers',
    name: 'matches a registered tail, hands the match to a pull, and takes its ack',
    run: async (ctx) => {
      const registered = (await ctx.board.watchers()).find((r) => r.owner === ctx.me.principal)
      // Registering replaces a principal's watchers: never on one that has some.
      if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
        return 'this token has watchers or a sync registered here, and checking would replace them'
      // Nothing's woken while it checks, and an empty one gets back where it's woken after.
      const where = wokenAt(registered)
      await ctx.board.register({ watch: { conformance: { tail: `${ctx.channel} --label conformance=${ctx.labels.conformance}` } } })
      try {
        const message = await post(ctx, 'conformance: for a watcher')
        const deadline = Date.now() + 10_000
        let match: Awaited<ReturnType<Board['matches']>>[number] | undefined
        while (!match && Date.now() < deadline) match = (await ctx.board.matches({ wait: 5 })).find((m) => m.event.message?.id === message.id)
        check(match, 'a pull should hand out the match for the post')
        same(match.watcher, 'conformance', "the match's watcher")
        await ctx.board.ack(match.id, { lease: match.lease })
        await rejects(ctx.board.ack(match.id, { lease: match.lease }), 404, 'no_match', 'acking a match twice')
      } finally {
        await ctx.board.register({ ...where, watch: {} })
      }
    },
  },
  {
    group: 'watchers',
    name: 'wakes by path only where its discovery says so, and only a Vercel project',
    run: async (ctx) => {
      // Even a refusal can replace them: a board that doesn't know `path` reads one as a registration with nothing in it.
      const registered = (await ctx.board.watchers()).find((r) => r.owner === ctx.me.principal)
      if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
        return 'this token has watchers or a sync registered here, and checking would replace them'
      const byPath = (await ctx.board.discovery()).wake_by_path
      // A path wakes a project's deployment in any environment, a preview's by its branch when it names one.
      const environment = /^vercel:project:[^:]+:(.+)$/.exec(ctx.me.principal)?.[1] ?? null
      const where = wokenAt(registered)
      const branch = environment === 'preview' ? { branch: 'conformance' } : {}
      const attempt = () => ctx.board.register({ path: '/conformance', ...branch, watch: {} })
      try {
        if (!byPath) await rejects(attempt(), 501, 'no_wake_by_path', 'a path, on a board that wakes nothing')
        else if (environment === null) await rejects(attempt(), 403, 'not_a_project', "a path, from a token that isn't a Vercel project's")
        else {
          const view = await attempt()
          same(view.path, '/conformance', "the registration's path")
          same(view.url, null, "the registration's url")
          same(view.branch ?? null, environment === 'preview' ? 'conformance' : null, "the registration's branch")
        }
      } finally {
        await ctx.board.register({ ...where, watch: {} })
      }
    },
  },
  {
    group: 'watchers',
    name: "refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking",
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const narrowed = ctx.withCan(`${ctx.channel}=all`)
      const registered = (await ctx.board.watchers()).find((r) => r.owner === ctx.me.principal)
      // What's registered now, so a board that wrongly takes it leaves the registration as it was.
      const now = { ...wokenAt(registered), watch: registered?.watch ?? {}, ...(registered?.sync ? { sync: registered.sync } : {}) }
      await narrowedOut(narrowed.register(now), 'registering watchers')
      await narrowedOut(narrowed.matches(), 'pulling matches')
      await narrowedOut(narrowed.ack(`conformance-${ctx.labels.conformance}`, { lease: 'conformance' }), 'acking a match')
    },
  },
  {
    group: 'sync',
    name: "keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced",
    run: async (ctx) => {
      const key = SYNC_KEY
      const thread = `${key}:${ctx.labels.conformance}:1`
      const author = { id: `${key}:user:${ctx.labels.conformance}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      const origin = { thread, message: '1' }
      // A sync names its entries when it registers.
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      const { where } = registered
      let imported: { message: string | null }
      try {
        imported = await ctx.board.syncImport({
          op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform', labels: ctx.labels, noSync: true,
          origin: { channel: `${key}:${ctx.labels.conformance}`, thread, subthread: null, message: '1', context: null },
          id: `conformance-sync-${ctx.labels.conformance}`,
        })
      } catch (error) {
        await ctx.board.register({ ...where, watch: {} }).catch(() => {})
        if (error instanceof BoardError && error.status === 403) return `this token can't sync in ${ctx.channel}`
        throw error
      }
      const id = imported.message
      isRef(id, "an import's message")
      try {
        const message = (await ctx.board.thread(id!)).message
        // A sync elsewhere's word: the platform user as a profile of its principal, shown through it.
        same(message.by.actor, `${ctx.me.principal}+${author.id}`, "the import's author")
        same(message.by.principal, ctx.me.principal, "the import's principal")
        same(message.by.profile, author.id, "the import's profile")
        same(message.author?.name, author.name, "the import's author's name")
        check(message.author?.via !== undefined, `the import's author should say who it's via, got ${show(message.author)}`)
        same(message.from, key, "the import's from")
        same(message.origin?.thread, thread, "the import's origin")
        const found = await ctx.board.syncFind({ thread, message: '1' })
        same(found.message, id, 'the message found by its platform IDs')
        check(found.thread !== null, 'the thread found by its platform thread')
        same((await ctx.board.syncThread(found.thread!)).root, id, "the synced thread's root")
        const again = await ctx.board.syncImport({ op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform', noSync: true, id: `conformance-sync-${ctx.labels.conformance}` })
        same(again.message, id, 'the same import, sent again')
        // A platform thread is one board thread's: another import can't take it over.
        await rejects(
          ctx.board.syncImport({ op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: a second root', noSync: true, origin: { thread, subthread: null, message: '3', context: null } }),
          409,
          'already_synced',
          'an import from a platform thread another board thread syncs with',
        )
        // A delivery is to one of its thread's targets.
        const external = { thread: `${key}:${ctx.labels.conformance}:2`, message: '2' }
        await ctx.board.syncReceipt({ kind: 'thread', message: id!, target: external.thread, targetKind: 'thread', cause: 'request' })
        await ctx.board.syncReceipt({ kind: 'message', message: id!, target: external.thread, external })
        same(JSON.stringify((await ctx.board.syncCopies([id!]))[id!]?.[external.thread]), JSON.stringify(external), 'the copy its receipt recorded')
        // Readers see where it's synced from the same records, and a link no sync here knows names nothing.
        const { targets } = await ctx.board.sync(id!)
        check(targets.some((row) => row.target === external.thread && row.message === external.message), `where the thread is synced should show the copy its receipt recorded, got ${show(targets)}`)
        await rejects(ctx.board.linked(`https://conformance.invalid/${ctx.labels.conformance}`), 404, 'message_not_found', 'a link no sync here knows')
      } finally {
        // Its author is the platform user: only an import can take it down.
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin }).catch(() => {})
        // And a second root, on a board that took one.
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin: { thread, message: '3' } }).catch(() => {})
        await ctx.board.register({ ...where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: "meets a platform user an import's text mentions: an actor as one who wrote would be, whom the text names by that actor's ID",
    run: async (ctx) => {
      const key = SYNC_KEY
      const thread = `${key}:${ctx.labels.conformance}:mentioned`
      const author = { id: `${key}:user:${ctx.labels.conformance}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      // Someone the platform knows, who has written nothing here.
      const cc = { id: `${key}:user:${ctx.labels.conformance}-cc`, handle: 'conformance-cc', name: 'Conformance Cc', avatar: null, isBot: false }
      const origin = { thread, message: '1' }
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      const { where } = registered
      try {
        let imported: { message: string | null }
        try {
          imported = await ctx.board.syncImport({
            op: 'post', author, from: key, channel: ctx.channel, text: `conformance: cc @[${cc.id}]`, mentioned: [cc], labels: ctx.labels, noSync: true,
            origin: { channel: `${key}:${ctx.labels.conformance}`, thread, subthread: null, message: '1', context: null },
            id: `conformance-mentioned-${ctx.labels.conformance}`,
          })
        } catch (error) {
          if (error instanceof BoardError && error.status === 403) return `this token can't sync in ${ctx.channel}`
          throw error
        }
        isRef(imported.message, "an import's message")
        // A sync elsewhere's user is a profile of its principal, mentioned or writing.
        const actor = `${ctx.me.principal}+${cc.id}`
        same((await ctx.board.thread(imported.message!)).message.text, `conformance: cc @[${actor}]`, "the import's text, its mention by the actor's ID")
        const met = (await ctx.board.actors()).find((known) => known.id === actor)
        check(met !== undefined, `the board should know the user the import mentioned as ${actor}`)
        same(met?.name, cc.name, "the mentioned user's name")
      } finally {
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin }).catch(() => {})
        await ctx.board.register({ ...where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: "queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked",
    run: async (ctx) => {
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      try {
        const run = ctx.labels.conformance
        const author = { id: `${SYNC_KEY}:user:${run}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
        const thread = `${SYNC_KEY}:${run}:inbox`
        const eventOf = (message: string) => ({
          id: `conformance-inbox-${run}-${message}`,
          event: { kind: 'message' as const, channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message, isRoot: message === '1', text: `conformance: inbox event ${message}`, context: null, author },
          raw: { conformance: run, message },
        })
        const pushed = [eventOf('1'), eventOf('2')]
        await ctx.board.inboxPush(SYNC_KEY, pushed)
        // A platform's retry of an event lands once.
        await ctx.board.inboxPush(SYNC_KEY, [pushed[0]!])
        const lease = async () => (await ctx.board.inboxNext(SYNC_KEY, { limit: 50 })).filter((item) => item.thread === thread)
        // A platform thread's events come one at a time, in order: each only once the one before is acked.
        for (const { event, raw } of pushed) {
          const leased = await lease()
          same(leased.length, 1, `the events leased from the platform thread, for message ${event.message}`)
          const item = leased[0]!
          same(item.event.kind === 'message' ? item.event.message : null, event.message, 'the platform message leased next')
          same(JSON.stringify(item.raw), JSON.stringify(raw), "the leased event's raw payload")
          await ctx.board.inboxAck(SYNC_KEY, item.id, { lease: item.lease })
        }
        same((await lease()).length, 0, 'the events leased once both are acked')
      } finally {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: "takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one",
    run: async (ctx) => {
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      try {
        const run = ctx.labels.conformance
        const author = { id: `${SYNC_KEY}:user:${run}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
        const thread = `${SYNC_KEY}:${run}:long`
        const location = { channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message: '1', author }
        // A deployment comment, edited from Building to Ready: thousands of characters, as platforms send them.
        const text = (status: string) => `conformance: ${status}\n${'| project | deployment | preview | updated |\n'.repeat(250)}`
        const idOf = (kind: string) => `conformance-inbox-${run}-long-${kind}-`.padEnd(INBOX_EVENT_ID_MAX, 'x')
        const pushed = [
          { id: idOf('message'), event: { kind: 'message' as const, ...location, isRoot: true, text: text('Building'), context: null }, raw: null },
          { id: idOf('edited'), event: { kind: 'edited' as const, ...location, text: text('Ready') }, raw: null },
        ]
        for (const event of pushed) await ctx.board.inboxPush(SYNC_KEY, [event])
        await refused(
          ctx.board.inboxPush(SYNC_KEY, [{ ...pushed[1]!, id: `${pushed[1]!.id}x` }]),
          400,
          `an inbox event ID over ${INBOX_EVENT_ID_MAX} characters`,
        )
        for (const { event } of pushed) {
          const leased = (await ctx.board.inboxNext(SYNC_KEY, { limit: 50 })).filter((item) => item.thread === thread)
          same(leased.length, 1, `the events leased from the platform thread, for its ${event.kind} event`)
          const item = leased[0]!
          same(item.event.kind, event.kind, 'the platform event leased next')
          same('text' in item.event ? item.event.text : null, event.text, `the ${event.kind} event's text`)
          await ctx.board.inboxAck(SYNC_KEY, item.id, { lease: item.lease })
        }
      } finally {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: 'hands a sync each message change as a match of its @sync watcher',
    run: async (ctx) => {
      // A token that syncs elsewhere but not here gets no match for a post here. One that names no
      // sync anywhere, as a board that lists no permissions, is checked.
      const access = compileAccess(ctx.me.can)
      if (access.anywhere('sync') && !access.can('sync', ctx.channel)) return `this token can't sync in ${ctx.channel}`
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      try {
        const message = await post(ctx, 'conformance: for a sync')
        const deadline = Date.now() + 10_000
        let match: Awaited<ReturnType<Board['matches']>>[number] | undefined
        while (!match && Date.now() < deadline) match = (await ctx.board.matches({ wait: 5 })).find((m) => m.watcher === '@sync' && m.event.message?.id === message.id)
        check(match, "a pull should hand the sync a match for the post, as its @sync watcher's")
        same(match.event.type, 'message.posted', "the sync's match")
        await ctx.board.ack(match.id, { lease: match.lease })
      } finally {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: 'keeps noSync on a post and a reply, so sync sends neither',
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const thread = await ctx.board.thread(root.id)
      same(thread.message.noSync, true, "a post's noSync, read back")
      same(thread.replies.find((m) => m.id === reply.id)?.noSync, true, "a reply's noSync, read back")
    },
  },
  {
    group: 'sync',
    name: "refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox",
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const { root } = needRoot(ctx)
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      const run = ctx.labels.conformance
      const author = { id: `${SYNC_KEY}:user:${run}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      const thread = `${SYNC_KEY}:${run}:narrowed`
      try {
        const narrowed = ctx.withCan(`${ctx.channel}=all`)
        await narrowedOut(
          narrowed.syncImport({
            op: 'post', author, from: SYNC_KEY, channel: ctx.channel, text: 'conformance: a narrowed import', labels: ctx.labels, noSync: true,
            origin: { channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message: '1', context: null },
          }),
          'an import',
        )
        await narrowedOut(narrowed.syncReceipt({ kind: 'failed', message: root.id, target: thread, error: 'conformance' }), 'a receipt')
        const event = { kind: 'message' as const, channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message: '1', isRoot: true, text: 'conformance: a narrowed push', context: null, author }
        await narrowedOut(narrowed.inboxPush(SYNC_KEY, [{ id: `conformance-narrowed-${run}`, event, raw: null }]), 'a push to the inbox')
        await narrowedOut(narrowed.inboxNext(SYNC_KEY, { limit: 1 }), 'a lease from the inbox')
        await narrowedOut(narrowed.inboxAck(SYNC_KEY, `conformance-narrowed-${run}`, { lease: 'conformance' }), 'an ack to the inbox')
      } finally {
        // An import a board wrongly took: only an import can take it down.
        await ctx.board.syncImport({ op: 'delete', author, from: SYNC_KEY, origin: { thread, message: '1' } }).catch(() => {})
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
]

/**
 * Why `principals` can't be the ones the grants checks name: one that is this run's own (its
 * project, or its repository from a GitHub run) would have the checks change what the run itself
 * may do, part way through. Null when they're another's.
 */
function namesCaller(me: Me, principals: ConformanceOptions['principals']): string | null {
  const [source, kind, id] = me.principal.split(':')
  const project = principals?.project
  if (project !== undefined && source === 'vercel' && kind === 'project' && (project === id || project === me.handle))
    return `principals.project is this run's own project, ${project}: the grants checks would change what this run may do. Name another project on the team.`
  const repository = principals?.repository?.toLowerCase()
  if (repository !== undefined && me.kind === 'workflow' && repository === me.handle.toLowerCase())
    return `principals.repository is this run's own repository, ${principals!.repository}: the grants checks would change what this run may do. Name another repository.`
  const app = principals?.app
  if (app !== undefined && source === 'vercel' && kind === 'app' && (app === id || app === me.handle))
    return `principals.app is this run's own app, ${app}: the grants checks would change what this run may do. Name another app on the team.`
  return null
}

/**
 * Why `project`, a name the board looks up, can't be the one the grants checks name: it's this run's
 * own. A name can't be told apart before the board resolves it, so this makes one grant that
 * changes nothing for the run (the project's deployments in another environment, posting in the
 * subtree's `ci/`), reads the project it resolved to, and revokes it. Null when it's another's, or
 * when the board made no such grant, which the grants checks then say why.
 */
async function ownProjectByName(board: Board, me: Me, channel: string, project: string | undefined): Promise<string | null> {
  const [source, kind, id, environment] = me.principal.split(':')
  if (project === undefined || source !== 'vercel' || kind !== 'project' || project === id) return null
  let grant: GrantView
  try {
    ;({ grant } = await board.createGrant({ principals: [{ kind: 'project', project, environments: [environment === 'preview' ? 'development' : 'preview'] }], can: { [`${channel}/grants/ci/`]: ['post'] } }))
  } catch {
    return null
  }
  // A revoke that fails throws: the run mustn't go on with it, or leave it unsaid.
  await board.revokeGrant(grant.id)
  const [named] = grant.principals
  return named?.kind === 'project' && named.projectId === id
    ? `principals.project is this run's own project, ${project} (${id}): the grants checks would change what this run may do. Name another project on the team.`
    : null
}

/**
 * Runs the checks against `board`, in order, and reports each. It never throws for what the board
 * answers; it throws before it writes anything when `principals` names the run itself.
 */
export async function conformance(board: Board, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const checks: CheckResult[] = []
  const discovery = await board.discovery().catch((error: unknown) => error as Error)
  const wrong =
    discovery instanceof Error
      ? discovery.message
      : typeof discovery.audience !== 'string' || typeof discovery.url !== 'string' || !Array.isArray(discovery.sync)
        ? `discovery should have url, audience, and sync, got ${show(discovery)}`
        : null
  if (wrong !== null) {
    checks.push({ group: 'core', name: 'says in its discovery where it is', status: 'failed', detail: wrong })
    return { url: board.url, checks, ok: false }
  }
  // The board it checks, as it names itself: a handle on one elsewhere has no URL of its own.
  const url = (discovery as { url: string }).url
  checks.push({ group: 'core', name: 'says in its discovery where it is', status: 'passed' })
  const me = await board.me()
  const own = namesCaller(me, options.principals)
  if (own !== null) throw new TypeError(own)
  const channel = options.channel ?? 'conformance'
  const ownByName = await ownProjectByName(board, me, channel, options.principals?.project)
  if (ownByName !== null) throw new TypeError(ownByName)
  const label = crypto.randomUUID().slice(0, 8)
  const ctx: Context = {
    board,
    channel,
    labels: { conformance: label },
    start: (await board.channel(channel).messages({ limit: 1 })).cursor,
    me,
    posted: [],
    ...(options.withCan ? { withCan: options.withCan } : options.withHeaders ? { withCan: (can: string) => options.withHeaders!({ 'x-board-can': can }) } : {}),
    ...(options.withHeaders ? { withHeaders: options.withHeaders } : {}),
    principals: {
      project: options.principals?.project ?? `prj_conformance${label}`,
      repository: options.principals?.repository ?? `acme/conformance-${label}`,
      viewer: options.principals?.viewer ?? null,
      app: options.principals?.app ?? null,
    },
    team: (discovery as { team_id?: string | null }).team_id ?? null,
  }
  try {
    for (const { group, name, run } of CHECKS) {
      try {
        const skipped = await run(ctx)
        checks.push(skipped ? { group, name, status: 'skipped', detail: skipped } : { group, name, status: 'passed' })
      } catch (error) {
        if (OPTIONAL.has(group) && error instanceof BoardError && error.status === 501) checks.push({ group, name, status: 'skipped', detail: `not kept here: ${error.message}` })
        // Vercel's API takes watchers only from a deployment: a run as anyone else can't check them.
        else if (group === 'watchers' && error instanceof BoardError && error.code === 'watchers_need_project') checks.push({ group, name, status: 'skipped', detail: 'only a deployment registers watchers here' })
        // A board that takes no GitHub or OIDC principal in a grant can't check what names one.
        else if (group === 'grants' && error instanceof BoardError && error.code === 'unsupported_principal') checks.push({ group, name, status: 'skipped', detail: 'this board takes no GitHub or OIDC principals in a grant' })
        else checks.push({ group, name, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    // What it posted goes, replies first. A failure here leaves a tombstone short, not a wrong report.
    for (const id of [...ctx.posted].reverse()) await board.delete(id).catch(() => {})
  }
  return { url, checks, ok: checks.every((c) => c.status !== 'failed') }
}
