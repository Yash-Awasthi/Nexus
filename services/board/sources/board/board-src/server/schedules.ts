import { idempotentId, reducer } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import type { ScheduleBodyOutput, ScheduleView, SchedulesQueryOutput } from '../api/routes.ts'
import { duration } from '../client/client.ts'
import {
  SCHEDULES_SESSION,
  schedulesContract,
  type ScheduleEvent,
  type ScheduleEvents,
} from '../contract/contract.ts'
import { actorKind, authorView, type Attachment, type Author, type Labels } from '../contract/schemas.ts'
import { authorize, type Access } from './access.ts'
import { wroteAs, type Granted, type Known, type Principal } from './auth.ts'
import { actorsReducer } from '../contract/reducers.ts'
import type { ActorsState } from '../contract/folds.ts'
import { badRequest, HttpError, notFound } from './errors.ts'
import { authorizePost, deploymentIdentity, type Identity, type WriteContext } from './writes.ts'
import type { WriteOrigin } from './origin.ts'
import { DroppedError } from './middleware.ts'
import { indexOf, ref, scheduleRef, viaOfRecord } from './feed.ts'
import { waitUntil } from './wait-until.ts'
import { storedPrincipal } from './registry.ts'
import { ownedActor } from './actors.ts'

/** Vercel Queues delays at most 6 days: a send further out than this goes in hops. */
export const MAX_HOP_MS = 5 * 86_400_000
/** The shortest repeat, so a typo can't flood a thread. */
export const MIN_EVERY_MS = 60_000
/** How far out a schedule reaches: its first send, stop, and repeat. Keeps every time a real date. */
export const MAX_AHEAD_MS = 366 * 86_400_000
/** A timer that fires this early just waits again; any closer counts as on time. */
const EARLY_MS = 1000

export type Schedule = {
  id: number
  channel: string
  re: number | null
  text: string
  labels: Labels
  noSync: boolean
  attachments: Attachment[]
  first: number
  every: number | null
  until: number | null
  times: number | null
  /** Its creator, as plain data: A2 snapshots state, and each send works out the access again. */
  as: Omit<Identity, 'principal'> & { principal: Omit<Principal, 'access'> }
  createdAt: string
  /** Its creator couldn't read its channel when it scheduled it. */
  blind: boolean
  /** Sends posted so far. */
  sent: number
  /** When the next send is due, or null when it's done or canceled. */
  next: number | null
  /** The last message it posted. */
  last: number | null
  canceled: { by: Author; reason: 'canceled' | 'thread_deleted' | 'dropped' | 'revoked' } | null
}

/** `takeover`: the Vercel deployment that sends, the last to take over, and its event's index; null before any has. */
export type SchedulesState = { byId: Record<string, Schedule>; takeover: { deployment: string; index: number } | null }

/**
 * Who a schedule sends as: its creator, shown as its principal names it. One made before handles were
 * checked keeps the actor its creator's client named; it sends as what verified that creator instead.
 */
const identityOf = (as: ScheduleEvent & { type: 'schedule.created' }): Schedule['as'] => {
  const { author, principal, actor } = as.payload.as
  const stored = { ...principal, expiresAt: null }
  return {
    author,
    principal: stored,
    actor: ownedActor(stored, author, { ...actor, kind: actorKind(actor.kind) }),
  }
}

export function foldSchedules(state: SchedulesState, event: ScheduleEvent): SchedulesState {
  switch (event.type) {
    case 'schedule.created': {
      const { payload } = event
      state.byId[event.index] = {
        id: event.index,
        channel: payload.channel,
        re: payload.re,
        text: payload.text,
        labels: { ...payload.labels },
        noSync: payload.noSync,
        attachments: payload.attachments ?? [],
        first: payload.first,
        every: payload.every,
        until: payload.until,
        times: payload.times,
        as: identityOf(event),
        createdAt: new Date(event.createdAt).toISOString(),
        blind: payload.blind ?? false,
        sent: 0,
        next: payload.first,
        last: null,
        canceled: null,
      }
      return state
    }
    case 'schedule.canceled': {
      const schedule = state.byId[event.payload.id]
      if (!schedule || schedule.next === null) return state
      schedule.next = null
      schedule.canceled = { by: event.payload.by, reason: event.payload.reason }
      return state
    }
    case 'schedule.fired': {
      const schedule = state.byId[event.payload.id]
      if (!schedule || schedule.next === null || schedule.sent !== event.payload.n) return state
      schedule.sent++
      schedule.last = event.payload.message
      schedule.next = event.payload.next
      return state
    }
    case 'schedule.takeover':
      state.takeover = { deployment: event.payload.deployment, index: event.index }
      return state
    default:
      return state
  }
}

export const schedulesReducer = reducer({
  contract: schedulesContract,
  name: 'board.schedules.v2',
  initialState: { byId: {}, takeover: null } as SchedulesState,
})
  .fold(foldSchedules)

/** The send after one due at `at`: the next slot after now, so downtime skips missed slots instead of replaying them. */
export function nextSend(schedule: Pick<Schedule, 'every' | 'until' | 'times'>, n: number, at: number, now: number): number | null {
  if (schedule.every === null) return null
  if (schedule.times !== null && n + 1 >= schedule.times) return null
  const next = at + schedule.every * Math.max(1, Math.floor((now - at) / schedule.every) + 1)
  return schedule.until !== null && next > schedule.until ? null : next
}

/**
 * Whether `principal` is the schedule's creator, as far as seeing and canceling
 * it goes. A principal ID is coarser than access (a repo's workflows share one,
 * and so do the proxies narrowing one token with `x-board-can`), so it also
 * needs `post` there now, as it would to create it. Where it can't read, the
 * schedule is its own only if it was created without reading too, so a
 * principal ID shared with a caller that reads doesn't reach that caller's.
 * A profile owns only what was scheduled as it; its principal, as no profile, owns all of them (`wroteAs`).
 */
export const createdBy = (schedule: Schedule, identity: { principal: Pick<Granted, 'id' | 'access'>; actor: { id: string } }) =>
  wroteAs(identity, { principal: schedule.as.principal.id, actor: schedule.as.actor.id }) &&
  identity.principal.access.can('post', schedule.channel) &&
  (schedule.blind || identity.principal.access.readable(schedule.channel))

export const scheduleView = (schedule: Schedule, actors: ActorsState): ScheduleView => {
  const author = actors.byId[schedule.as.actor.id] ?? schedule.as.actor
  const via = viaOfRecord({ id: schedule.as.actor.id, handle: author.handle, via: 'via' in author ? author.via : undefined })
  return {
    id: scheduleRef(schedule.id),
    channel: schedule.channel,
    re: schedule.re === null ? null : ref(schedule.re),
    text: schedule.text,
    labels: { ...schedule.labels },
    noSync: schedule.noSync,
    attachments: schedule.attachments,
    first: new Date(schedule.first).toISOString(),
    every: schedule.every,
    until: schedule.until === null ? null : new Date(schedule.until).toISOString(),
    times: schedule.times,
    sent: schedule.sent,
    next: schedule.next === null ? null : new Date(schedule.next).toISOString(),
    last: schedule.last === null ? null : ref(schedule.last),
    state: schedule.canceled ? 'canceled' : schedule.next === null ? 'done' : 'pending',
    canceled: schedule.canceled && { ...schedule.canceled, by: authorView(schedule.canceled.by) },
    by: authorView(schedule.as.author),
    author: { kind: author.kind, handle: author.handle, name: author.name, avatar: author.avatar, ...(via ? { via } : {}) },
    createdAt: schedule.createdAt,
  }
}

/** What a send records in the schedules. */
type ScheduleAppend = { [K in 'schedule.canceled' | 'schedule.fired']: { type: K; payload: Extract<ScheduleEvent, { type: K }>['payload'] } }['schedule.canceled' | 'schedule.fired']

const SYSTEM = deploymentIdentity('board:schedule', 'schedule')

/** The board's `accessNow`: a stored creator's access under the rules as they are now, or null. */
type AccessNow = (principal: Known) => Promise<Access | null>

/** A send, as the board posts it for its creator: a post's input, with `re` as a ref. Throws `DroppedError` when the middleware drops it. */
type Send = (
  identity: Identity,
  origin: WriteOrigin,
  input: { channel?: string; re?: string; id: string; text: string; labels: Labels; noSync: boolean; attachments?: string[] },
) => Promise<{ id: string }>

/** A refusal (a 403, or a 404 for a thread the creator can no longer read) as null; anything else still throws. */
const refused = (error: unknown): null => {
  if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return null
  throw error
}

/**
 * Scheduled messages: `schedule.created` arms the first send as an A2 timer, and
 * each `schedule.due` posts as the schedule's creator, then arms the next.
 */
export function createSchedules(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  let writes: WriteContext | null = null
  let accessNow: AccessNow | null = null
  /** Posts as `identity`, through what every post does: the middleware too. */
  let send: Send | null = null
  /** Vercel Queues delivers a timer only to the deployment that armed it, which runs its own code and access rules. */
  const deployment = process.env.VERCEL_DEPLOYMENT_ID || null

  /**
   * Where this deployment's timers land: a session of its own on Vercel. A queue drains one session
   * at a time, and Vercel Queues drains it on the deployment that appended to it, so an earlier
   * deployment never drains the one that sends' timers, and can't drop them there.
   */
  const sends = deployment === null ? SCHEDULES_SESSION : `${SCHEDULES_SESSION}:${deployment}`

  /**
   * Arms send `n`, due at `at`: the whole way, or one hop toward it. A timer's name is its identity
   * in the queue, so arming the same send under the same name again adds nothing; only a hop's names
   * the hop, since a send waits through several.
   */
  async function arm(name: string, id: number, n: number, at: number) {
    const hop = Math.max(Math.min(at, Date.now() + MAX_HOP_MS), Date.now())
    const named = name === 'hop' ? `hop-${id}-${n}-${hop}` : `${name}-${id}-${n}`
    await session.forSends.schedule(named, { at: new Date(hop) }, { type: 'schedule.due', payload: { id, n, at } })
  }

  /** Appends to the schedules, once for each `key`, from a send in any session. */
  async function record(event: ScheduleAppend, ...key: string[]) {
    await session.append({ ...event, id: await idempotentId('board-schedule-record', ...key) })
  }

  async function due(ctx: ConsumerContext<ScheduleEvents, 'schedule.due'>) {
    if (!writes || !accessNow || !send) throw new Error('schedules used before the board bound them')
    const { id, n, at } = ctx.event.payload
    const { state } = await session.state(schedulesReducer, { through: 'latest' })
    const schedule = state.byId[id]
    // A later deployment armed this send itself when it took over, and decides it under the rules as they are now.
    // The one that sends runs any timer that reaches it, whoever armed it: a scheduler that delivers to one URL brings them all here.
    if (deployment !== null && state.takeover !== null && state.takeover.deployment !== deployment) return
    // This send went out, and an attempt before this one stopped short of arming the next: arm it now.
    if (schedule && ctx.attempt > 1 && schedule.sent === n + 1 && schedule.next !== null) return arm('next', id, n + 1, schedule.next)
    // Canceled, done, or a stale timer for a send already made.
    if (!schedule || schedule.next !== at || schedule.sent !== n) return
    if (Date.now() < at - EARLY_MS) return arm('hop', id, n, at)

    if (schedule.re !== null) {
      const root = await writes.reads.message(schedule.re, ctx.signal)
      if (!root || root.deleted) {
        await record({ type: 'schedule.canceled', payload: { id, by: SYSTEM.author, reason: 'thread_deleted' } }, 'ended', String(id))
        return
      }
    }
    // Each send has its creator's access under the rules as they are now, never what it had then.
    const access = await accessNow(schedule.as.principal)
    const target = schedule.re === null ? { channel: schedule.channel } : { re: schedule.re }
    const proofs = access && (await authorizePost(writes, access, { ...target, labels: schedule.labels }).catch(refused))
    if (!access || !proofs) {
      console.info(`[board] schedule s${id}'s creator can no longer post it in ${schedule.channel}`)
      await record({ type: 'schedule.canceled', payload: { id, by: SYSTEM.author, reason: 'revoked' } }, 'ended', String(id))
      return
    }
    // A retry after the post landed gets the same event ID, so the board hands back the message it already posted.
    // The send is marked as the schedule's, and a handle that's ambiguous since it was checked stays plain text.
    const input = {
      ...(schedule.re === null ? { channel: schedule.channel } : { re: ref(schedule.re) }),
      id: await idempotentId('board-schedule', String(id), String(n)),
      text: schedule.text,
      labels: schedule.labels,
      noSync: schedule.noSync,
      ...(schedule.attachments.length ? { attachments: schedule.attachments.map((file) => file.id) } : {}),
    }
    let posted: number
    try {
      const sent = await send({ ...schedule.as, principal: { ...schedule.as.principal, access } }, { via: { kind: 'schedule', id }, schedule: { id, n } }, input)
      posted = indexOf(sent.id)!
    } catch (error) {
      if (!(error instanceof DroppedError)) throw error
      // Its text never changes, so the middleware would drop every send after this one too.
      console.info(`[board] the middleware dropped schedule s${id}: ${error.message}`)
      await record({ type: 'schedule.canceled', payload: { id, by: SYSTEM.author, reason: 'dropped' } }, 'ended', String(id))
      return
    }
    const next = nextSend(schedule, n, at, Date.now())
    await record({ type: 'schedule.fired', payload: { id, n, message: posted, next } }, 'fired', String(id), String(n))
    if (next !== null) await arm('next', id, n + 1, next)
  }

  /**
   * Arms each schedule's next send, as the schedule stands now, from the first schedule on: the
   * first deploy with this consumer arms every schedule from before it.
   */
  const arming = consumer({
    contract: schedulesContract,
    name: 'board-schedules',
    types: ['schedule.created'],
    lane: 'schedules',
    backfill: true,
  }).run(async (ctx) => {
    if (!options.scheduler) return
    // Latest, not through `schedule.created`: one that has sent since waits on a later send.
    const { state } = await ctx.session.state(schedulesReducer, { through: 'latest' })
    const schedule = state.byId[ctx.event.index]
    if (!schedule || schedule.next === null) return
    await arm('first', schedule.id, schedule.sent, schedule.next)
  })

  /** Makes each due send, one schedule at a time. */
  const sending = consumer({
    contract: schedulesContract,
    name: 'board-schedule-sends',
    types: ['schedule.due'],
    lane: ({ event }) => `schedule:${event.payload.id}`,
  }).run(due)

  const server = createServer({
    contract: schedulesContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [arming, sending],
  })
  const session = Object.assign(server.session(SCHEDULES_SESSION), { forSends: server.session(sends) })
  const scheduled = options.scheduler !== undefined

  /**
   * Makes this deployment the one that sends, unless it already is, and arms every pending
   * schedule's next send here, since the timers an earlier deployment armed only reach it. Each
   * instance arms them again, under the same names, so one created on an earlier deployment
   * after the takeover, or missed by a takeover that failed partway, still gets a timer here.
   */
  async function takeOver(): Promise<void> {
    if (deployment === null) return
    const read = await session.state(schedulesReducer)
    let { state } = read
    if (state.takeover?.deployment !== deployment) {
      await session.append({
        type: 'schedule.takeover',
        payload: { deployment },
        // Instances starting together take over once.
        id: await idempotentId('board-schedule-takeover', deployment, String(read.index)),
      })
      state = (await session.state(schedulesReducer)).state
    }
    const since = state.takeover!.index
    for (const schedule of Object.values(state.byId))
      if (schedule.next !== null) await arm(`takeover-${since}`, schedule.id, schedule.sent, schedule.next)
  }

  /**
   * The first call on an instance starts the arming catching up, and doesn't wait: on the first
   * deploy with it, every schedule from before gets its next send armed here. The first call that
   * isn't a queue's delivery takes schedules over too: a deployment nobody visits any more still
   * gets its own timers, and those mustn't take schedules back from the one people reach.
   */
  let catching: Promise<unknown> | null = null
  let taking: Promise<unknown> | null = null
  function catchUp(options: { takeOver: boolean }): void {
    if (!scheduled) return
    if (!catching) {
      catching = session.consume(arming).catch((error: unknown) => {
        console.warn('[board] schedules are not caught up:', (error as Error).message)
        catching = null
      })
      waitUntil(catching)
    }
    if (options.takeOver && !taking) {
      taking = takeOver().catch((error: unknown) => {
        console.warn('[board] schedules are not taken over:', (error as Error).message)
        taking = null
      })
      waitUntil(taking)
    }
  }

  /** `visible`: which schedules the caller may see. */
  async function list(query: SchedulesQueryOutput & { root?: number }, visible: (schedule: Schedule) => boolean = () => true) {
    if (!writes) throw new Error('schedules used before the board bound them')
    const [{ state }, { state: actors }] = await Promise.all([
      session.state(schedulesReducer),
      writes.session.state(actorsReducer),
    ])
    return Object.values(state.byId)
      .filter(visible)
      .filter((s) => (query.all ? true : s.next !== null))
      .filter((s) => (query.root === undefined ? true : s.re === query.root))
      .filter((s) => (query.channel === undefined ? true : s.channel === query.channel))
      .filter((s) => (query.by === undefined ? true : s.as.actor.id === query.by || s.as.actor.handle.toLowerCase() === query.by.toLowerCase()))
      .sort((a, b) => a.id - b.id)
      .map((s) => scheduleView(s, actors))
  }

  return {
    server,
    session,
    catchUp,
    bind: (binding: { writes: WriteContext; accessNow: AccessNow; send: Send }) => {
      writes = binding.writes
      accessNow = binding.accessNow
      send = binding.send
    },
    list,
    /** The pending schedules that reply in the thread rooted at `root`. */
    forThread: (root: number) => list({ root }),

    async create(
      identity: Identity,
      /** The body, with `re` as the log index it names. */
      body: Omit<ScheduleBodyOutput, 're'> & { re?: number | undefined },
      attachments: Attachment[],
    ): Promise<{ schedule: ScheduleView }> {
      if (!writes) throw new Error('schedules used before the board bound them')
      if (!options.scheduler) throw new HttpError(501, 'no_scheduler', "this board has no scheduler, so it can't send later")
      const now = Date.now()
      const every = body.every === undefined ? null : duration(body.every)
      if (every !== null && every < MIN_EVERY_MS) throw badRequest('`every` is at least 1m')
      if (every !== null && every > MAX_AHEAD_MS) throw badRequest('`every` is at most a year')
      const first = body.at !== undefined ? Date.parse(body.at) : now + duration(body.in ?? body.every!)
      if (first < now - 60_000) throw badRequest('`at` is in the past')
      const until = body.until !== undefined ? Date.parse(body.until) : body.for !== undefined ? first + duration(body.for) : null
      if (until !== null && until < first) throw badRequest('the schedule stops before its first send')
      if (first > now + MAX_AHEAD_MS || (until !== null && until > now + MAX_AHEAD_MS))
        throw badRequest('a schedule reaches at most a year out: its first send and its stop')

      let channel = body.channel
      let re: number | null = null
      if (body.re !== undefined) {
        const target = await writes.reads.message(body.re)
        if (!target || target.deleted) throw notFound(`message not found: #${body.re}`, 'message_not_found')
        re = target.re ?? target.id
        channel = target.channel
      }
      const [row] = await session.append({
        type: 'schedule.created',
        payload: {
          channel: channel!,
          re,
          text: body.text,
          labels: body.labels ?? {},
          noSync: body.noSync ?? false,
          ...(attachments.length ? { attachments } : {}),
          first,
          every,
          until,
          times: body.times ?? null,
          as: {
            author: identity.author,
            principal: storedPrincipal(identity.principal),
            actor: identity.actor,
          },
          ...(identity.principal.access.readable(channel!) ? {} : { blind: true as const }),
        },
      })
      const { state } = await session.state(schedulesReducer)
      // Armed here too, not only by the arming consumer: an earlier deployment that drains the schedules first would arm it there, where it never sends.
      const created = state.byId[row!.index]!
      if (created.next !== null) await arm('first', created.id, created.sent, created.next)
      const { state: actors } = await writes.session.state(actorsReducer)
      return { schedule: scheduleView(created, actors) }
    },

    /**
     * Its creator may cancel it while they can post there, and so may `manage`
     * in its channel. Anyone else gets 403 where they can read it, and 404
     * where they can't. Canceling twice is a no-op.
     */
    async cancel(identity: Identity, id: number): Promise<{ schedule: ScheduleView; canceled: boolean }> {
      if (!writes) throw new Error('schedules used before the board bound them')
      const { state } = await session.state(schedulesReducer)
      const schedule = state.byId[id]
      const missing = () => notFound(`schedule not found: s${id}`, 'schedule_not_found')
      if (!schedule) throw missing()
      if (!createdBy(schedule, identity)) authorize(identity.principal.access, 'manage', schedule.channel, missing)
      const canceled = schedule.next !== null
      if (canceled) await session.append({ type: 'schedule.canceled', payload: { id, by: identity.author, reason: 'canceled' } })
      const { state: after } = await session.state(schedulesReducer)
      const { state: actors } = await writes.session.state(actorsReducer)
      return { schedule: scheduleView(after.byId[id]!, actors), canceled }
    },
  }
}
