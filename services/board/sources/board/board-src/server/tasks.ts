import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import { LEASE_DEFAULT_S, type MessageView, type TaskClaim } from '../api/routes.ts'
import type { Protocol } from '../api/protocol.ts'
import { LEASES_SESSION, leasesContract, type LeaseEvents } from '../contract/contract.ts'
import type { BoardEvent } from '../contract/events.ts'
import { foldMessages, type Message, type MessagesState, type Task } from '../contract/folds.ts'
import { actorsReducer, channelsReducer } from '../contract/reducers.ts'
import { OPEN_TASK_STATES, TASK_BATCH_MAX, TASK_KEY_MAX, TASK_LABEL, TASK_NEEDS_MAX, TASK_NOTE_MAX, TaskHoldKind, type TaskState } from '../contract/schemas.ts'
import { batchPlan, type BatchNeed } from '../contract/task-batch.ts'
import { authorize, type Access, type Permission } from './access.ts'
import { badRequest, batchTooLarge, forbidden, HttpError, notFound } from './errors.ts'
import { indexOf, ref, toMessageFilter, view, whoIs } from './feed.ts'
import type { MessageFilter, ThreadSummary } from '../store/types.ts'
import { appendFrom, authorizeMessage, movedOn, ownedBy, seenFor, untilApplied, type Along, type AlongEach, type Events, type Identity, type WriteContext } from './writes.ts'

/** The shortest and the longest lease this board gives, in seconds. */
export const LEASE_MIN_S = 30
export const LEASE_CAP_S = 3600
/** How many owners one claim takes tasks from on this board, beside its caller. */
const FROM_MAX = 32

/**
 * This board's own limits on a task. board() checks a request's shape and leaves how much a
 * backend holds to the backend, so these are checked here: what's over one is refused as a
 * misshapen request is, 400 `invalid_request`, before anything is read or written.
 */
export const taskLimits = {
  lease(seconds: number | undefined) {
    if (seconds !== undefined && !(seconds >= LEASE_MIN_S && seconds <= LEASE_CAP_S)) throw badRequest(`lease: a lease is ${LEASE_MIN_S} to ${LEASE_CAP_S} seconds`)
  },
  needs(refs: readonly string[] | undefined) {
    if (new Set(refs).size > TASK_NEEDS_MAX) throw badRequest(`needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`)
  },
  note(what: 'result' | 'reason', note: string | null | undefined) {
    if (typeof note === 'string' && note.length > TASK_NOTE_MAX) throw badRequest(`${what}: a task's ${what} is at most ${TASK_NOTE_MAX.toLocaleString('en-US')} characters`)
  },
  kind(kind: string | undefined) {
    if (kind !== undefined && !TaskHoldKind.safeParse(kind).success) throw badRequest('kind: a kind is up to 64 lowercase letters, numbers, and _.-')
  },
  from(owners: readonly string[] | undefined) {
    if ((owners?.length ?? 0) > FROM_MAX) throw badRequest(`from: a claim takes tasks from at most ${FROM_MAX} owners`)
  },
  /** A batch: how many tasks this board makes in one append, which its sender splits on, and of each what one task holds. */
  batch(tasks: readonly { key?: string | undefined; needs?: readonly BatchNeed[] | undefined }[]) {
    if (tasks.length > TASK_BATCH_MAX) throw batchTooLarge(tasks.length, TASK_BATCH_MAX)
    for (const [at, task] of tasks.entries()) {
      if (task.key !== undefined && task.key.length > TASK_KEY_MAX) throw badRequest(`tasks.${at}.key: a task's key is at most ${TASK_KEY_MAX} characters`)
      // Each task it waits for once, however it's named: one of the batch by its key, one that's there by its ID.
      const waits = new Set(task.needs?.map((need) => (typeof need === 'string' ? `id ${need}` : `key ${need.key}`)))
      if (waits.size > TASK_NEEDS_MAX) throw badRequest(`tasks.${at}.needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`)
    }
  },
}
/** A timer that fires this early waits again; any closer counts as on time. */
const EARLY_MS = 1000
/** Roots a scan of tasks reads at a time. */
const PAGE = 500

/** A task's root: the message that carries it. */
type Root = Message & { task: Task }

/** What a claim's own writes show: the `epoch` and `token` its claim answered. */
type Proof = { epoch: number; token: string }

const conflict = (code: string, message: string) => new HttpError(409, code, message)
const notATask = (id: number) => notFound(`#${id} isn't a task`, 'not_a_task')

/** 128 random bits, base64url: a claim's secret, which the board answers once and keeps only the hash of. */
const newToken = () => randomBytes(16).toString('base64url')
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
/** Whether `token` is the secret `hash` was made from, compared without saying how much of it matched. */
const hashes = (token: string, hash: string) => timingSafeEqual(Buffer.from(hashOf(token), 'hex'), Buffer.from(hash, 'hex'))

/** A lease asked for in seconds, as this board gives it, in milliseconds. */
const leaseOf = (seconds: number | undefined) => Math.min(seconds ?? LEASE_DEFAULT_S, LEASE_CAP_S) * 1000

/** Whether a task's claim has run out its lease: it's claimable at once, whatever its label still says. */
const lapsed = (task: Task, at: number) => task.state === 'claimed' && Date.parse(task.claim!.until) <= at

/** A task's state as claims and lists take it: a claim whose lease has run out is ready. */
const stateNow = (task: Task, at: number): TaskState => (lapsed(task, at) ? 'ready' : task.state)

const finished = (task: Task) => task.state === 'completed' || task.state === 'failed' || task.state === 'canceled'

/** How many tasks a change of what a task needs walks, behind the ones it adds, to see that none waits for it. */
export const NEEDS_WALK_MAX = 500

/** Whether `value` is shaped like an ID, `<where it's from>:<who>`, as every principal's and actor's is. What it names is a credential's to say, never a client's. */
const isId = (value: string) => /^[^\s:]+:\S+$/.test(value)

/** Waits `ms`, or until `signal` aborts, whichever is first. */
const paused = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/** The profile part of an actor ID, as the board writes one: lowercase. */
const PROFILE = /^[a-z][a-z0-9-]{0,31}$/

/**
 * The actor a task is assigned to: one of its owner's (`<owner>+<profile>`), or null for anyone who
 * may claim it. Another principal's actor is refused: a profile is the owner's own word for which of
 * its agents does what.
 */
function ownActor(owner: string, actor: string | null | undefined): string | null {
  if (actor === undefined || actor === null) return null
  if (!actor.startsWith(`${owner}+`) || !PROFILE.test(actor.slice(owner.length + 1)))
    throw badRequest(`for: a task is assigned to one of its owner's profiles, ${owner}+<profile>, got ${actor}`)
  return actor
}

/**
 * Tasks on a local board: a thread with a state, kept on its root. Every write here is one
 * conditional append: it reads the task as the tables have it, decides, and lands only while that
 * read is still the log's last word, so of writes that race, one lands and the rest look again.
 * A claim's lease is timed outside the board log, which holds only what came of it.
 */
export function createTasks(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  let bound: WriteContext | null = null
  const writes = (): WriteContext => {
    if (!bound) throw new Error('tasks used before the board bound them')
    return bound
  }

  /**
   * A claim's lease, timed: when it's due, the task's claim expires if it's still that claim and
   * its lease wasn't renewed. A renewal arms its own timer, so one for an earlier end fires into
   * nothing.
   */
  async function due(context: ConsumerContext<LeaseEvents, 'lease.due'>) {
    const ctx = writes()
    const { id, epoch, at } = context.event.payload
    const read: { early: string | null } = { early: null }
    const rows = await appendFrom(ctx, async () => {
      read.early = null
      const position = await ctx.reads.tables.position()
      const root = (await ctx.reads.tables.messagesAt([id], position)).get(id)
      const task = root?.task
      // Released, settled, held, or claimed again since: this claim is over already.
      if (!root || !task || task.state !== 'claimed' || task.epoch !== epoch) return { position, events: [] }
      const until = Date.parse(task.claim!.until)
      if (until - Date.now() > EARLY_MS) {
        // Renewed, with a timer of its own; or delivered early, and it waits again.
        if (until === at) read.early = task.claim!.until
        return { position, events: [] }
      }
      return { position, events: [{ type: 'task.expired', payload: { id, thread: root.thread, epoch } }] }
    })
    await untilApplied(ctx, rows)
    if (read.early !== null) await arm(id, epoch, read.early, `again-${context.event.index}`)
  }

  const expiring = consumer({
    contract: leasesContract,
    name: 'board-leases',
    types: ['lease.due'],
    lane: ({ event }) => `task:${event.payload.id}`,
  }).run(due)

  const server = createServer({
    contract: leasesContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [expiring],
  })
  const leases = server.session(LEASES_SESSION)

  /**
   * Arms the timer for a claim's lease. Without a scheduler there's none: a claim still checks the
   * clock, so a lease that ran out is claimable, and its label says so once someone claims it. One
   * that can't be armed is the same, so the claim that landed still answers.
   */
  async function arm(id: number, epoch: number, until: string, again?: string) {
    if (!options.scheduler) return
    const at = Date.parse(until)
    const name = `lease-${id}-${epoch}-${at}${again ? `-${again}` : ''}`
    await leases.schedule(name, { at: new Date(at) }, { type: 'lease.due', payload: { id, epoch, at } }).catch((error: unknown) => {
      console.warn(`[board] no timer for #${id}'s lease, which a claim still ends:`, (error as Error).message)
    })
  }

  /** A message the caller may read, as the tables have it: a 404 otherwise, as if it weren't there. */
  async function readable(access: Access, id: number): Promise<Message> {
    const message = await writes().reads.message(id)
    if (!message || !access.readable(message.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
    return message
  }

  /** A task the caller may read, by its root's ID. Who it is and where it is never change, so what a caller may do to it is checked on this read. */
  async function taskOf(access: Access, id: number): Promise<Root> {
    const message = await readable(access, id)
    if (!message.task) throw notATask(id)
    return message as Root
  }

  /** `message` as `identity` sees it. */
  async function shown(identity: Identity, message: Message): Promise<MessageView> {
    const ctx = writes()
    const { state: actors } = await ctx.session.state(actorsReducer)
    return view(message, actors, await ctx.reads.reader(identity.principal.access, [message]))
  }

  /**
   * One write to the message `id`: `decide` gets it as it is at the index the write will land after,
   * throws what refuses the write, and returns what to append. Answers the message as the write left
   * it: as it was, when there was nothing to append.
   */
  async function change(identity: Identity, id: number, decide: (found: Message, position: number) => Events | Promise<Events>): Promise<Message> {
    const ctx = writes()
    const seen = seenFor(identity, (await ctx.session.state(actorsReducer)).state)
    const read: { before?: Message } = {}
    const rows = await appendFrom(ctx, async () => {
      const position = await ctx.reads.tables.position()
      const found = (await ctx.reads.tables.messagesAt([id], position)).get(id)
      if (!found) throw notFound(`message not found: #${id}`, 'message_not_found')
      read.before = found
      const events = await decide(found, position)
      return { position, events: events.length > 0 && seen ? [seen, ...events] : events }
    })
    await untilApplied(ctx, rows)
    return after(read.before!, rows)
  }

  /** `message` once `rows`, a write's own events, are applied to it: what the write answers, whatever lands next. */
  function after(message: Message, rows: readonly { index: number }[]): Message {
    const state: MessagesState = { byId: { [message.id]: structuredClone(message) }, replies: {} }
    for (const row of [...rows].sort((a, b) => a.index - b.index)) foldMessages(state, row as unknown as BoardEvent)
    return state.byId[message.id]!
  }

  /** `change`, for a write to a task: `decide` gets its root. */
  const changeTask = (identity: Identity, id: number, decide: (root: Root, position: number) => Events | Promise<Events>) =>
    change(identity, id, (found, position) => {
      if (!found.task) throw notATask(id)
      return decide(found as Root, position)
    })

  /**
   * Whether the caller changes a task as its owner: `manage` in its channel, or the owner while it
   * may still write there. A principal ID is coarser than access (a proxy narrows one token with
   * `x-board-can`), so one narrowed to reading doesn't cancel its principal's tasks. And a
   * principal's profiles share its credential (a sandbox's agent writes as one), so, as with a
   * message, a profile changes only the tasks it made, and the principal itself any of them:
   * otherwise one profile would assign itself what was another's.
   */
  function owns(identity: Identity, root: Root) {
    const { access } = identity.principal
    if (access.can('manage', root.channel)) return
    if (ownedBy(root.task, identity) && (access.can('post', root.channel) || access.can('label', root.channel))) return
    throw new HttpError(403, 'task_not_owned', `#${root.id} is someone else's task: its owner as itself, the profile that made it, or manage in ${root.channel}, changes it`)
  }

  /** Refuses a write whose claim is over: released, settled, held, taken over, or past its lease. It never says who holds the task now. */
  function fenced(root: Root, proof: Proof) {
    const { task } = root
    const live = task.state === 'claimed' && task.epoch === proof.epoch && Date.parse(task.claim!.until) > Date.now() && hashes(proof.token, task.claim!.token)
    if (!live) throw conflict('claim_lost', `this claim on #${root.id} is over: claim it again`)
  }

  /**
   * Whether `identity` is who a task is assigned to: its owner's principal, writing as that actor.
   * The actor ID alone doesn't say whose it is. An ID is a principal's and then `+<profile>`, and
   * another principal's own ID can end that way, so the two can be one string.
   */
  const assignedTo = (task: Task, identity: Identity) => task.for === identity.actor.id && task.owner === identity.principal.id

  /** Refuses a claim of a task that can't be claimed now, by `identity`. */
  function claimable(root: Root, identity: Identity) {
    const { task } = root
    if (task.state === 'waiting') throw conflict('task_waiting', `#${root.id} waits for ${task.needs.map((need) => `#${need}`).join(', ')}`)
    if (task.state === 'blocked') throw conflict('task_blocked', `#${root.id} is held for a person: ${task.blocked!.reason}`)
    if (finished(task)) throw conflict('task_finished', `#${root.id} is ${task.state}`)
    if (task.for !== null && !assignedTo(task, identity)) throw conflict('task_assigned', `#${root.id} is assigned to ${task.for}`)
    if (task.state === 'claimed' && !lapsed(task, Date.now())) throw conflict('task_claimed', `#${root.id} is claimed until ${task.claim!.until}`)
  }

  /**
   * A claim of a task as it stands, by `identity`: the events, and what the claim answers. A claim
   * whose lease ran out expires in the same append, so the log says what happened to it.
   */
  function claiming(root: { id: number; thread: string }, task: Pick<Task, 'state' | 'epoch'> | null, identity: Identity, lease: number | undefined, token: string): { events: Events; claim: TaskClaim } {
    const about = { id: root.id, thread: root.thread }
    const epoch = (task?.epoch ?? 0) + 1
    const until = new Date(Date.now() + leaseOf(lease)).toISOString()
    return {
      events: [
        ...(task?.state === 'claimed' ? [{ type: 'task.expired' as const, payload: { ...about, epoch: task.epoch } }] : []),
        { type: 'task.claimed', payload: { ...about, epoch, until, token: hashOf(token), by: identity.author } },
      ],
      claim: { epoch, token, until },
    }
  }

  /**
   * The tasks `refs` name, as of `position`, and whether they've all completed. One that isn't a
   * task, or that the caller can't read, is refused alike, so `needs` says nothing of what's out of
   * sight. Needs never change, and nothing can need a thread before it's a task, so the only cycle
   * there could be is a task that waits for itself: `self` isn't a task yet, so it's refused as any
   * thread that isn't one, and named here only so the refusal says why. One that was canceled is
   * refused too: it can never complete, so a task that waited for it would wait for good, and its
   * maker hears now. A failed one may yet be reopened, so it's still something to wait for.
   */
  async function needsAt(access: Access, refs: readonly string[] | undefined, position: number, self: number | null): Promise<{ ids: number[]; completed: boolean }> {
    const named = namedNeeds(refs, self)
    return needsAmong(access, named, named.size === 0 ? new Map<number, Message>() : await writes().reads.tables.messagesAt([...named.keys()], position))
  }

  const invalidNeed = (value: string, why: string) => badRequest(`needs: #${value} ${why}`, 'invalid_needs')

  /** The messages `refs` name, each by the ref that named it: one that names none, or `self`, is refused. */
  function namedNeeds(refs: readonly string[] | undefined, self: number | null): Map<number, string> {
    const named = new Map<number, string>()
    for (const value of refs ?? []) {
      const id = indexOf(value)
      if (id === null || id === 0) throw invalidNeed(value, "isn't a task")
      if (id === self) throw invalidNeed(value, "is the task itself: it can't wait for itself")
      named.set(id, value)
    }
    return named
  }

  /** The tasks `named` names among `found`, the messages read for them, and whether they've all completed. */
  function needsAmong(access: Access, named: ReadonlyMap<number, string>, found: ReadonlyMap<number, Message>): { ids: number[]; completed: boolean } {
    for (const [id, value] of named) {
      const need = found.get(id)
      if (!need?.task || !access.readable(need.channel)) throw invalidNeed(value, "isn't a task")
      if (need.task.state === 'canceled') throw invalidNeed(value, 'was canceled: it can never complete')
    }
    const ids = [...named.keys()]
    return { ids, completed: ids.every((id) => found.get(id)!.task!.state === 'completed') }
  }

  /**
   * Refuses prerequisites that would make task `id` wait for itself: one that waits for it already,
   * through however many tasks. A new task can't be waited for, so only a change of what a task
   * needs can close a cycle, and only with a prerequisite it adds: one the task keeps was looked
   * behind when it was added, and whatever came to wait behind it since was checked as it did. So
   * it walks what the `added` ones need, and what those need, a level a read, and gives up past
   * `NEEDS_WALK_MAX` tasks: a change it can't check is refused too. One that only drops some walks
   * nothing.
   *
   * It follows no completed task's needs that `access` reads. A task completes by a claim, which
   * it takes only once all it needs has completed, and neither it nor they change after: completed
   * is for good, and a finished task's needs can't be changed. So everything behind a completed
   * task has completed, and task `id`, which hasn't, isn't there. Finished work behind a
   * prerequisite, however much, is never too much to check. One the caller can't read is followed
   * all the same, completed or not: the walk reads tasks out of the caller's sight, as it must to
   * find a cycle, so where it stops, and whether it gets past `NEEDS_WALK_MAX`, must depend on
   * nothing the caller can't see. A canceled task is followed: it may have waited for anything.
   */
  async function acyclic(access: Access, id: number, added: readonly number[], position: number) {
    const invalid = (need: number, why: string) => badRequest(`needs: #${need} ${why}`, 'invalid_needs')
    /** Each task the walk reached, by the added prerequisite it reached it from. */
    const from = new Map<number, number>(added.map((need) => [need, need]))
    for (let level = [...added]; level.length > 0; ) {
      const found = await writes().reads.tables.messagesAt(level, position)
      const next: number[] = []
      for (const at of level) {
        const message = found.get(at)
        const task = message?.task
        if (!task || (task.state === 'completed' && access.readable(message.channel))) continue
        for (const need of task.needs) {
          if (need === id) throw invalid(from.get(at)!, `waits for #${id} already: they would wait for each other`)
          if (from.has(need)) continue
          from.set(need, from.get(at)!)
          next.push(need)
        }
      }
      if (from.size > NEEDS_WALK_MAX) throw invalid(added[0]!, `has more than ${NEEDS_WALK_MAX} tasks behind it and the others: too many to check that none waits for #${id}`)
      level = next
    }
  }

  /** Whether every task `task` waits for has completed, as of `position`, leaving out `but`, which is completing now. */
  async function satisfied(task: Task, position: number, but?: number): Promise<boolean> {
    const ids = task.needs.filter((id) => id !== but)
    if (ids.length === 0) return true
    const found = await writes().reads.tables.messagesAt(ids, position)
    return ids.every((id) => found.get(id)?.task?.state === 'completed')
  }

  /** Every root that wears `board.task` as one of `states` and matches `filter`, oldest first, all as of `position`. */
  async function* rootsAt(filter: MessageFilter, states: readonly TaskState[], position: number): AsyncGenerator<Root> {
    const labels = [...(filter.labels ?? []), { key: TASK_LABEL, values: states }]
    for (let after = 0; ; ) {
      const page = await writes().reads.tables.roots({ ...filter, labels }, { after, limit: PAGE })
      // A page that reflects a later index than the write looked at: the board moved on, and it looks again.
      if (page.position !== position) throw movedOn()
      for (const { root } of page.threads) if (root.task) yield root as Root
      if (page.threads.length < PAGE) return
      after = page.threads.at(-1)!.root.id
    }
  }

  /** `task.ready` for each task that waited only for `id`, which is completing: its dependents, in the same append. */
  async function readied(id: number, position: number): Promise<Events> {
    const events: Events = []
    for await (const root of rootsAt({}, ['waiting'], position))
      if (root.task.needs.includes(id) && (await satisfied(root.task, position, id))) events.push({ type: 'task.ready', payload: { id: root.id, thread: root.thread } })
    return events
  }

  /**
   * `filter`, narrowed to the channels where `access` gives `permission` among those the log has,
   * and the index that list reflects. One that gives it everywhere needs nothing more.
   */
  async function within(filter: MessageFilter, access: Access, permission: Permission): Promise<{ filter: MessageFilter; through: number }> {
    if (access.everywhere(permission)) return { filter, through: Number.POSITIVE_INFINITY }
    const { state, index } = await writes().session.state(channelsReducer)
    const { channel, ...rest } = filter
    const inside = (path: string) => !channel || path === channel.path || (channel.subtree && path.startsWith(`${channel.path}/`))
    return { filter: { ...rest, channels: Object.keys(state).filter((path) => inside(path) && access.can(permission, path)) }, through: index }
  }

  /** The IDs a handle or an ID names, itself included: an owner or an assignee the board has yet to see write is still found by its ID. */
  async function named(value: string): Promise<Set<string>> {
    const who = whoIs(value, (await writes().session.state(actorsReducer)).state)
    return new Set([value, ...who.actors, ...who.principals])
  }

  /**
   * The owner a claim's `from` names: the principal with that ID. A task's text is instructions for
   * whoever claims it, so whose it takes is never a handle's to say: a handle is how someone shows,
   * and several can show the same, one a client picked and one a credential gave alike (two projects
   * on different teams share a name). An ID is one principal's alone, whether or not the board has
   * seen it write as itself: one that only ever wrote through a profile owns its tasks all the same.
   */
  function ownerFrom(value: string): string {
    if (isId(value)) return value
    throw badRequest(`from: ${value} is a handle, which several can share: name the owner by ID`, 'invalid_from')
  }

  /** A claim of the oldest ready task there that the caller takes, or null when there's none now. */
  async function claimNext(identity: Identity, input: Protocol['claimReadyTask']['input'], signal: AbortSignal): Promise<{ root: Message; claim: TaskClaim } | null> {
    const ctx = writes()
    const { principal, actor } = identity
    const subtree = input.channel.endsWith('/')
    const channel = { path: subtree ? input.channel.slice(0, -1) : input.channel, subtree }
    // A claim changes a task's state, which is what `label` gives: where the caller has none, there's nothing it claims.
    if (!subtree) authorize(principal.access, 'label', channel.path)
    else if (!principal.access.anywhere('label')) throw forbidden("this token can't label anywhere, so it can't claim a task")
    const base: MessageFilter = { channel, labels: Object.entries(input.label ?? {}).map(([key, value]) => ({ key, values: [value] })) }
    const { filter } = await within(base, principal.access, 'label')
    if (filter.channels?.length === 0) return null
    // Whose tasks it takes: its own, and those of the owners it names.
    const owners = new Set([principal.id])
    for (const value of input.from ?? []) owners.add(ownerFrom(value))
    const seen = seenFor(identity, (await ctx.session.state(actorsReducer)).state)
    const token = input.token ?? newToken()
    const read: { taken: { root: Root; claim: TaskClaim } | null } = { taken: null }
    const rows = await appendFrom(ctx, async () => {
      read.taken = null
      const position = await ctx.reads.tables.position()
      const now = Date.now()
      // One assigned to the caller first, then the oldest unassigned one of an owner it takes tasks from.
      let pool: Root | null = null
      let mine: Root | null = null
      for await (const root of rootsAt(filter, ['ready', 'claimed'], position)) {
        const { task } = root
        if (stateNow(task, now) !== 'ready') continue
        if (assignedTo(task, identity)) {
          mine = root
          break
        }
        if (task.for === null && pool === null && owners.has(task.owner)) pool = root
      }
      const root = mine ?? pool
      // A caller that stopped waiting takes nothing: a task claimed for no one would sit out its lease.
      if (!root || signal.aborted) return { position, events: [] }
      const { events, claim } = claiming(root, root.task, identity, input.lease, token)
      read.taken = { root, claim }
      return { position, events: seen ? [seen, ...events] : events }
    })
    if (read.taken === null) return null
    const { root, claim } = read.taken
    await untilApplied(ctx, rows)
    await arm(root.id, claim.epoch, claim.until)
    return { root: after(root, rows), claim }
  }

  return {
    server,
    bind: (binding: { writes: WriteContext }) => {
      bound = binding.writes
    },

    /**
     * What makes a new thread a task, to append with its root: `task.created`, `task.ready` when
     * the tasks it needs have all completed, and its claim when it asks for one. `claimed(id)` is
     * what that claim answers once root `id` landed: null for a task made without one, or one this
     * request didn't make (a retry of a post that landed gets the post back, and no claim).
     */
    starting(
      identity: Identity,
      input: { channel: string; needs?: string[] | undefined; for?: string | null | undefined; claim?: boolean | undefined; lease?: number | undefined; token?: string | undefined },
    ): { along: Along; claimed: (id: number) => Promise<TaskClaim | null> } {
      const { principal, actor, author } = identity
      const assigned = ownActor(principal.id, input.for)
      // Claiming is what `label` gives, on a task made in the same write as on any other.
      if (input.claim) authorize(principal.access, 'label', input.channel)
      const token = input.token ?? newToken()
      const along: Along = async () => {
        const position = await writes().reads.tables.position()
        const needs = await needsAt(principal.access, input.needs, position, null)
        const waits = needs.ids.length > 0 && !needs.completed
        if (input.claim && waits) throw conflict('task_waiting', `the task would wait for ${needs.ids.map((id) => `#${id}`).join(', ')}: nothing was made`)
        if (input.claim && assigned !== null && assigned !== actor.id) throw conflict('task_assigned', `the task would be assigned to ${assigned}: nothing was made`)
        return {
          position,
          events: (root) => {
            const about = { id: root.id, thread: root.thread }
            const events: Events = [{ type: 'task.created', payload: { ...about, needs: needs.ids, for: assigned, by: author } }]
            if (needs.ids.length > 0 && !waits) events.push({ type: 'task.ready', payload: about })
            if (input.claim) events.push(...claiming(root, null, identity, input.lease, token).events)
            return events
          },
        }
      }
      const claimed = async (id: number): Promise<TaskClaim | null> => {
        if (!input.claim) return null
        // The claim the root wears is this request's only if it was made with this request's secret.
        const held = (await writes().reads.message(id))?.task
        if (!held?.claim || !hashes(token, held.claim.token)) return null
        await arm(id, held.epoch, held.claim.until)
        return { epoch: held.epoch, token, until: held.claim.until }
      }
      return { along, claimed }
    },

    /**
     * What makes several new threads tasks, to append with their roots, all in one write: for each,
     * `task.created`, and `task.ready` when it waits only for tasks that were there and have all
     * completed. A task waits for the batch's others by their `key`, wherever they come in it, and
     * those are new, so it waits. Refused before anything is read: an assignee that isn't its
     * owner's, a `key` two tasks have or none has, and tasks that wait for each other.
     */
    startingMany(identity: Identity, tasks: readonly { key?: string | undefined; needs?: readonly BatchNeed[] | undefined; for?: string | null | undefined }[]): AlongEach {
      const { principal, author } = identity
      const assigned = tasks.map((task) => ownActor(principal.id, task.for))
      const plan = batchPlan(tasks)
      if ('problem' in plan) throw badRequest(`needs: ${plan.problem}`, 'invalid_needs')
      const { inside } = plan
      const named = tasks.map((task) => namedNeeds((task.needs ?? []).filter((need) => typeof need === 'string'), null))
      const outside = [...new Set(named.flatMap((needs) => [...needs.keys()]))]
      return async () => {
        const position = await writes().reads.tables.position()
        // What the batch waits for that was there, read once for all its tasks.
        const found = outside.length === 0 ? new Map<number, Message>() : await writes().reads.tables.messagesAt(outside, position)
        const needs = named.map((refs) => needsAmong(principal.access, refs, found))
        const readied = needs.map(({ ids, completed }, at) => ids.length > 0 && completed && inside[at]!.length === 0)
        return {
          position,
          counts: readied.map((ready) => (ready ? 2 : 1)),
          events: (roots) =>
            roots.map((root, at): Events => {
              const about = { id: root.id, thread: root.thread }
              const waitsFor = [...needs[at]!.ids, ...inside[at]!.map((other) => roots[other]!.id)]
              return [{ type: 'task.created', payload: { ...about, needs: waitsFor, for: assigned[at]!, by: author } }, ...(readied[at] ? [{ type: 'task.ready' as const, payload: about }] : [])]
            }),
        }
      }
    },

    /**
     * Makes the thread rooted at `id` a task, as it is: `label` in its channel, and the caller's
     * principal owns it. A reply names no task, and neither does a root that's gone.
     */
    async adopt(identity: Identity, id: number, input: { needs?: string[] | undefined; for?: string | null | undefined; claim?: boolean | undefined; lease?: number | undefined; token?: string | undefined }): Promise<{ task: MessageView; claim?: TaskClaim }> {
      const { principal, actor, author } = identity
      await authorizeMessage(writes(), principal.access, 'label', id)
      const assigned = ownActor(principal.id, input.for)
      const token = input.token ?? newToken()
      const made: { claim: TaskClaim | null } = { claim: null }
      const root = await change(identity, id, async (found, position) => {
        made.claim = null
        if (found.re !== null) throw badRequest(`#${id} is a reply: a task is a thread, so name its root, #${found.re}`)
        if (found.deleted) throw badRequest('message was deleted', 'message_deleted')
        if (found.task) throw conflict('already_a_task', `#${id} is a task already`)
        const needs = await needsAt(principal.access, input.needs, position, id)
        const waits = needs.ids.length > 0 && !needs.completed
        if (input.claim && waits) throw conflict('task_waiting', `#${id} would wait for ${needs.ids.map((need) => `#${need}`).join(', ')}: it wasn't made a task`)
        if (input.claim && assigned !== null && assigned !== actor.id) throw conflict('task_assigned', `#${id} would be assigned to ${assigned}: it wasn't made a task`)
        const about = { id, thread: found.thread }
        const events: Events = [{ type: 'task.created', payload: { ...about, needs: needs.ids, for: assigned, by: author } }]
        if (needs.ids.length > 0 && !waits) events.push({ type: 'task.ready', payload: about })
        if (input.claim) {
          const claimed = claiming(found, null, identity, input.lease, token)
          events.push(...claimed.events)
          made.claim = claimed.claim
        }
        return events
      })
      const { claim } = made
      if (claim) await arm(id, claim.epoch, claim.until)
      return { task: await shown(identity, root), ...(claim ? { claim } : {}) }
    },

    /** Tasks the caller reads, oldest first, a page at a time. */
    async list(identity: Identity, query: Protocol['tasks']['input']): Promise<Protocol['tasks']['output']> {
      const ctx = writes()
      const { principal, actor } = identity
      const { state: actors } = await ctx.session.state(actorsReducer)
      const wanted = query.state ?? 'open'
      // A claim whose lease ran out still wears `claimed`: what's ready is looked for among both.
      const states: readonly TaskState[] | null = wanted === 'all' ? null : wanted === 'open' ? OPEN_TASK_STATES : wanted === 'ready' ? ['ready', 'claimed'] : [wanted]
      const base = toMessageFilter({ ...(query.channel !== undefined ? { channel: query.channel } : {}), ...(query.by !== undefined ? { by: query.by } : {}), ...(query.label ? { label: query.label } : {}) }, { me: { id: actor.id, handle: actor.handle }, actors, access: principal.access })
      const { filter, through } = await within({ ...base, labels: [...(base.labels ?? []), { key: TASK_LABEL, values: states }] }, principal.access, 'read')
      const owners = query.owner === undefined ? null : await named(query.owner)
      const assignees = query.for === undefined ? null : await named(query.for)
      // A ref that names nothing here is no task's prerequisite.
      const needed = query.needs === undefined ? null : (indexOf(query.needs) ?? -1)
      const now = Date.now()
      const matches = ({ task }: Root) =>
        (wanted === 'all' || wanted === 'open' || stateNow(task, now) === wanted) &&
        (owners === null || owners.has(task.owner)) &&
        (assignees === null || (task.for !== null && assignees.has(task.for))) &&
        (needed === null || task.needs.includes(needed))
      const limit = query.limit ?? 50
      const found: ThreadSummary[] = []
      let last = 0
      if (query.after !== undefined) {
        const at = indexOf(query.after)
        if (at === null) throw badRequest(`${query.after} isn't a cursor or a message ID on this board`, 'invalid_cursor')
        last = at
      }
      let position = await ctx.reads.position()
      // A reader of no channel has nothing to look for. A page that fills picks up after the last root it looked at.
      scan: for (let more = filter.channels?.length !== 0; more; ) {
        const page = await ctx.reads.roots(filter, { after: last, limit: PAGE })
        position = page.position
        more = page.threads.length === PAGE
        for (const thread of page.threads) {
          last = thread.root.id
          if (thread.root.task && matches(thread.root as Root)) found.push(thread)
          if (!query.latest && found.length === limit) break scan
        }
      }
      // Once it has read them all, the next read picks up at what the board has now.
      const cursor = !query.latest && found.length === limit ? last : Math.max(last, Math.min(position, through))
      // The last active: a sort keeps ties as they came, in the order they were made.
      const activeAt = (t: ThreadSummary) => (t.last ?? t.root).createdAt
      const kept = query.latest ? found.sort((a, b) => activeAt(a).localeCompare(activeAt(b))).slice(-limit) : found
      const reader = await ctx.reads.reader(principal.access, kept.flatMap((t) => (t.last ? [t.root, t.last] : [t.root])))
      return {
        tasks: kept.map((t) => ({ message: view(t.root, actors, reader), replies: t.replies, last: t.last && view(t.last, actors, reader) })),
        cursor: ref(cursor),
      }
    },

    /**
     * Claims a task: `label` in its channel, whoever owns it. Of claims that race, one lands. With
     * the token of the claim that holds it now, it answers that claim as it is.
     */
    async claim(identity: Identity, id: number, lease: number | undefined, sent: string | undefined): Promise<Protocol['claimTask']['output']> {
      const { principal, actor } = identity
      const { channel } = await taskOf(principal.access, id)
      authorize(principal.access, 'label', channel)
      const token = sent ?? newToken()
      const made: { claim?: TaskClaim } = {}
      const root = await changeTask(identity, id, (found) => {
        const { task } = found
        if (sent !== undefined && task.state === 'claimed' && !lapsed(task, Date.now()) && hashes(sent, task.claim!.token)) {
          made.claim = { epoch: task.epoch, token, until: task.claim!.until }
          return []
        }
        claimable(found, identity)
        const claimed = claiming(found, found.task, identity, lease, token)
        made.claim = claimed.claim
        return claimed.events
      })
      const claim = made.claim!
      await arm(id, claim.epoch, claim.until)
      return { task: await shown(identity, root), claim }
    },

    /** Claims the oldest ready task there, waiting up to `wait` seconds for one. */
    async claimReady(identity: Identity, input: Protocol['claimReadyTask']['input'], signal: AbortSignal): Promise<Protocol['claimReadyTask']['output']> {
      const deadline = Date.now() + (input.wait ?? 0) * 1000
      for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
        // Looked at again before every try: the caller may have gone while this waited.
        if (signal.aborted) return { task: null }
        const next = await claimNext(identity, input, signal)
        if (next) return { task: await shown(identity, next.root), claim: next.claim }
        if (Date.now() >= deadline) return { task: null }
        await paused(Math.min(pause, Math.max(0, deadline - Date.now())), signal)
      }
    },

    /** Extends a claim's lease from now. */
    async renew(identity: Identity, id: number, proof: Proof, lease: number | undefined): Promise<Protocol['renewTask']['output']> {
      await taskOf(identity.principal.access, id)
      const made = { until: '' }
      const root = await changeTask(identity, id, (found) => {
        fenced(found, proof)
        made.until = new Date(Date.now() + leaseOf(lease)).toISOString()
        return [{ type: 'task.renewed', payload: { id, thread: found.thread, epoch: proof.epoch, until: made.until, by: identity.author } }]
      })
      await arm(id, proof.epoch, made.until)
      return { task: await shown(identity, root), until: made.until }
    },

    /** What ends a claim, by the claim: released, completed, or failed. A completion readies the tasks that waited only for it. */
    async settle(
      identity: Identity,
      id: number,
      proof: Proof,
      how: { type: 'task.released' } | { type: 'task.completed'; result: string | null } | { type: 'task.failed'; reason: string },
    ): Promise<{ task: MessageView }> {
      await taskOf(identity.principal.access, id)
      const root = await changeTask(identity, id, async (found, position) => {
        fenced(found, proof)
        const about = { id, thread: found.thread, epoch: proof.epoch, by: identity.author }
        if (how.type === 'task.released') return [{ type: 'task.released', payload: about }]
        if (how.type === 'task.failed') return [{ type: 'task.failed', payload: { ...about, reason: how.reason } }]
        return [{ type: 'task.completed', payload: { ...about, result: how.result } }, ...(await readied(id, position))]
      })
      return { task: await shown(identity, root) }
    },

    /**
     * Holds a task for a person. A claimed task's hold is its claim's, which it ends; otherwise its
     * owner's, or `manage`'s. One whose lease ran out is no one's, so its owner holds it.
     */
    async block(identity: Identity, id: number, input: { reason: string; kind?: string | undefined; proof?: Proof | undefined }): Promise<{ task: MessageView }> {
      const task = await taskOf(identity.principal.access, id)
      if (!input.proof) owns(identity, task)
      const { proof } = input
      const root = await changeTask(identity, id, (found) => {
        if (proof) fenced(found, proof)
        else {
          const state = stateNow(found.task, Date.now())
          if (state === 'claimed') throw conflict('task_claimed', `#${id} is claimed until ${found.task.claim!.until}: only its claim holds it`)
          if (state === 'blocked') throw conflict('task_blocked', `#${id} is held already: ${found.task.blocked!.reason}`)
          if (finished(found.task)) throw conflict('task_finished', `#${id} is ${found.task.state}`)
        }
        return [{ type: 'task.blocked', payload: { id, thread: found.thread, kind: input.kind ?? null, reason: input.reason, by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },

    /** Lifts a hold: back to ready, or to waiting while a task it needs hasn't completed. One that isn't held is left as it is. */
    async unblock(identity: Identity, id: number): Promise<{ task: MessageView }> {
      owns(identity, await taskOf(identity.principal.access, id))
      const root = await changeTask(identity, id, async (found, position) => {
        if (finished(found.task)) throw conflict('task_finished', `#${id} is ${found.task.state}`)
        if (found.task.state !== 'blocked') return []
        const about = { id, thread: found.thread }
        // The fold puts a task that needs any back to waiting: what it needs may have completed while it was held.
        const ready = found.task.needs.length > 0 && (await satisfied(found.task, position))
        return [{ type: 'task.unblocked', payload: { ...about, by: identity.author } }, ...(ready ? [{ type: 'task.ready' as const, payload: about }] : [])]
      })
      return { task: await shown(identity, root) }
    },

    /** Makes a failed task ready again, in place, so what waits for it still does. One that's open is left as it is. */
    async reopen(identity: Identity, id: number): Promise<{ task: MessageView }> {
      owns(identity, await taskOf(identity.principal.access, id))
      const root = await changeTask(identity, id, (found) => {
        if (found.task.state === 'completed' || found.task.state === 'canceled') throw conflict('task_finished', `#${id} is ${found.task.state}`)
        return found.task.state === 'failed' ? [{ type: 'task.reopened', payload: { id, thread: found.thread, by: identity.author } }] : []
      })
      return { task: await shown(identity, root) }
    },

    /** Assigns a task to one of its owner's actors, or with null to anyone who may claim it. A claim it has stays. */
    async assign(identity: Identity, id: number, actor: string | null): Promise<{ task: MessageView }> {
      const task = await taskOf(identity.principal.access, id)
      owns(identity, task)
      const assigned = ownActor(task.task.owner, actor)
      const root = await changeTask(identity, id, (found) => {
        if (finished(found.task)) throw conflict('task_finished', `#${id} is ${found.task.state}`)
        return found.task.for === assigned ? [] : [{ type: 'task.assigned', payload: { id, thread: found.thread, for: assigned, by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },

    /**
     * Replaces what a task waits for, for its owner or `manage`, while no one holds it and it isn't
     * finished. They're checked as a new task's are, and must leave it waiting for no task that
     * waits for it. It waits for them from this write, and `task.ready` follows in it when they've
     * all completed; with none it's ready. A held task stays held, and the same set changes nothing.
     */
    async needs(identity: Identity, id: number, refs: readonly string[]): Promise<{ task: MessageView }> {
      const { principal } = identity
      owns(identity, await taskOf(principal.access, id))
      const root = await changeTask(identity, id, async (found, position) => {
        const { task } = found
        if (finished(task)) throw conflict('task_finished', `#${id} is ${task.state}`)
        // A claim whose lease ran out is over: its expiry goes first, in the same append.
        const over = lapsed(task, Date.now())
        if (task.state === 'claimed' && !over) throw conflict('task_claimed', `#${id} is claimed until ${task.claim!.until}: what it needs changes once no one holds it`)
        const needs = await needsAt(principal.access, refs, position, id)
        if (needs.ids.length === task.needs.length && needs.ids.every((need) => task.needs.includes(need))) return []
        await acyclic(principal.access, id, needs.ids.filter((need) => !task.needs.includes(need)), position)
        const about = { id, thread: found.thread }
        return [
          ...(over ? [{ type: 'task.expired' as const, payload: { ...about, epoch: task.epoch } }] : []),
          { type: 'task.needs_changed', payload: { ...about, needs: needs.ids, by: identity.author } },
          ...(needs.ids.length > 0 && needs.completed && task.state !== 'blocked' ? [{ type: 'task.ready' as const, payload: about }] : []),
        ]
      })
      return { task: await shown(identity, root) }
    },

    /** Cancels a task that hasn't completed, ending any claim. What waits for it keeps waiting. */
    async cancel(identity: Identity, id: number, reason: string): Promise<{ task: MessageView }> {
      owns(identity, await taskOf(identity.principal.access, id))
      const root = await changeTask(identity, id, (found) => {
        if (found.task.state === 'completed' || found.task.state === 'canceled') throw conflict('task_finished', `#${id} is ${found.task.state}`)
        return [{ type: 'task.canceled', payload: { id, thread: found.thread, reason, by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },
  }
}
