import { randomBytes } from 'node:crypto'
import { A2Error, idempotentId, reducer, type ContractEvent } from 'experimental-a2'
import type { BoardEventView, MatchView } from '../api/routes.ts'
import { watchContract, type WatchEvents } from '../contract/contract.ts'
import type { Access } from './access.ts'

/**
 * Registered watchers' matches, as a queue per watcher and thread in their registrant's session
 * (`watch:@<principal>`): the registrant pulls a thread's oldest match, runs it, and acks it, and
 * the thread's next match waits until then. Nothing wakes it: it pulls on its own.
 */

/** Tries before a match is given up on, as a watcher's own runs are. */
export const MATCH_TRIES = 5
/** How long a pulled match is its puller's before someone may pull it again. */
export const LEASE_MS = 5 * 60_000
/** After an error, a match waits 1 second, doubling to 30. */
export const retryDelay = (attempts: number) => Math.min(30_000, 1000 * 2 ** (attempts - 1))

/** The queue a registrant's sync pulls: every event it delivers. Watcher IDs start with a letter, so none is this. */
export const SYNC_QUEUE = '@sync'
/** The queue of platform events a registrant pushed for sync key `key`. */
export const inboxQueue = (key: string) => `@inbox:${key}`

type Pending = {
  id: string
  /** A registered watcher's ID, `SYNC_QUEUE`, or an `inboxQueue`. */
  queue: string
  thread: string
  event: unknown
  /** Tries that ended without finishing: errors and leases that ran out. */
  attempts: number
  lease: { id: string; until: number } | null
  /** After an error, when it may be pulled again. */
  retryAt: number | null
}

export type QueueState = {
  /** `<watcher>\u001f<thread>` → match IDs, oldest first: only the first is ever handed out. */
  queues: Record<string, string[]>
  pending: Record<string, Pending>
}

const queueKey = (queue: string, thread: string) => `${queue}\u001f${thread}`

function remove(state: QueueState, id: string) {
  const found = state.pending[id]
  if (!found) return
  delete state.pending[id]
  const key = queueKey(found.queue, found.thread)
  const rest = (state.queues[key] ?? []).filter((queued) => queued !== id)
  if (rest.length > 0) state.queues[key] = rest
  else delete state.queues[key]
}

function foldQueue(state: QueueState, event: ContractEvent<WatchEvents>): QueueState {
  switch (event.type) {
    case 'watch.matched': {
      const { watcher, sync, inbox, thread } = event.payload
      const queue = watcher ?? (sync ? SYNC_QUEUE : inbox !== undefined ? inboxQueue(inbox) : undefined)
      // A config watcher's match runs in-process; only registered ones queue here.
      if (queue === undefined || state.pending[event.id]) return state
      state.pending[event.id] = { id: event.id, queue, thread, event: event.payload.event, attempts: 0, lease: null, retryAt: null }
      ;(state.queues[queueKey(queue, thread)] ??= []).push(event.id)
      return state
    }
    case 'watch.leased': {
      const found = state.pending[event.payload.matched]
      if (found && !found.lease) found.lease = { id: event.payload.lease, until: event.payload.until }
      return state
    }
    case 'watch.acked': {
      const found = state.pending[event.payload.matched]
      // An ack under a lease that's no longer the match's changes nothing.
      if (!found || found.lease?.id !== event.payload.lease) return state
      if (event.payload.error === undefined) {
        remove(state, found.id)
        return state
      }
      found.attempts += 1
      found.lease = null
      found.retryAt = event.payload.retryAt ?? null
      return state
    }
    case 'watch.expired': {
      const found = state.pending[event.payload.matched]
      if (!found || found.lease?.id !== event.payload.lease) return state
      found.attempts += 1
      found.lease = null
      return state
    }
    case 'watch.retry': {
      const found = state.pending[event.payload.matched]
      if (found) found.retryAt = null
      return state
    }
    case 'watch.failed':
    case 'watch.skipped':
      remove(state, event.payload.matched)
      return state
    // A log from before boards stopped waking registrants has their sweeps and wake-ups: nothing reads them now.
    default:
      return state
  }
}

export const queueReducer = reducer({
  contract: watchContract,
  name: 'board.watch-queue.v5',
  initialState: { queues: {}, pending: {} } as QueueState,
}).fold(foldQueue)

type WatchInput = { type: string; id?: string; payload: unknown }

/** The parts of an A2 session of the watch contract that the queue uses. */
export type QueueSession = {
  state(r: typeof queueReducer): Promise<{ state: QueueState }>
  append(...events: WatchInput[]): Promise<unknown>
}

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

/**
 * Whether `access` may see `event` now, as it was matched: a message's channel, or every channel for
 * none. Sync's queue gets what its registrant may sync, since it speaks for platform users there.
 */
function readable(access: Access, event: unknown, queue: string) {
  const channel = (event as BoardEventView).message?.channel
  if (queue === SYNC_QUEUE) return channel === undefined ? access.everywhere('sync') : access.can('sync', channel)
  return channel === undefined ? access.readsAll : access.readable(channel)
}

/** An append that holds an event ID already in the log: another pull's lease. */
const taken = (error: unknown) => error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH'

/** Whether a match is free to pull now: no one holds it, and its wait after an error is over. A lease or wait whose time has passed counts as over. */
const free = (found: Pending, now: number) => !(found.lease && found.lease.until > now) && !(found.retryAt !== null && found.retryAt > now)

/** One item a pull leased: what was queued, and the lease its ack names. */
export type Leased = { id: string; queue: string; thread: string; event: unknown; lease: string; attempt: number }

/**
 * Hands out what the registrant's watchers and sync may run now: each queue's oldest match, if it's
 * free, leased to this pull. The inbox's queues are `pullInbox`'s.
 */
export async function pull(
  session: QueueSession,
  options: { access: Access; limit: number; now: number },
): Promise<MatchView[]> {
  const leased = await lease(session, { ...options, queues: (queue) => !queue.startsWith('@inbox:'), visible: (event, queue) => readable(options.access, event, queue) })
  return leased.map(({ id, queue, thread, lease, attempt, event }) => ({ id, watcher: queue, thread, lease, attempt, event: event as BoardEventView }))
}

/**
 * Hands out the platform events the registrant pushed for sync key `key`: each platform thread's
 * oldest, if it's free, while the registrant may still sync somewhere.
 */
export function pullInbox(session: QueueSession, key: string, options: { access: Access; limit: number; now: number }): Promise<Leased[]> {
  const queue = inboxQueue(key)
  return lease(session, { ...options, queues: (name) => name === queue, visible: () => options.access.anywhere('sync') })
}

/**
 * Leases what's free in the queues `queues` picks: each one's oldest item, which `visible` says
 * its registrant may still have. What the pull changes goes in one append, and one read after
 * tells which leases are this pull's: two pulls at once derive the same lease ID for a try, and
 * only one lands.
 */
async function lease(
  session: QueueSession,
  options: { limit: number; now: number; queues: (queue: string) => boolean; visible: (event: unknown, queue: string) => boolean },
): Promise<Leased[]> {
  const { state } = await session.state(queueReducer)
  const events: WatchInput[] = []
  const offered: { head: Pending; lease: string; attempt: number }[] = []
  for (const ids of Object.values(state.queues)) {
    if (offered.length >= options.limit) break
    const head = state.pending[ids[0]!]!
    if (!options.queues(head.queue) || !free(head, options.now)) continue
    let attempts = head.attempts
    if (head.lease) {
      // It ran out before a sweep said so: a try that didn't finish.
      events.push({ type: 'watch.expired', payload: { matched: head.id, lease: head.lease.id } })
      attempts += 1
      if (attempts >= MATCH_TRIES) {
        events.push(failure(head, `its lease ran out ${attempts} times`))
        continue
      }
    }
    if (!options.visible(head.event, head.queue)) {
      events.push({ type: 'watch.skipped', payload: { matched: head.id, reason: "its registrant can't have it anymore" } })
      continue
    }
    const lease = randomBytes(16).toString('hex')
    events.push({
      type: 'watch.leased',
      id: await idempotentId('board-lease', head.id, String(attempts)),
      payload: { matched: head.id, lease, until: options.now + LEASE_MS },
    })
    offered.push({ head, lease, attempt: attempts })
  }
  if (events.length === 0) return []
  // Another pull leased one of these first: the rest land one at a time, and its lease stays.
  await session.append(...events).catch(async (error: unknown) => {
    if (!taken(error)) throw error
    for (const event of events) await session.append(event).catch((one: unknown) => { if (!taken(one)) throw one })
  })
  if (offered.length === 0) return []
  const { state: after } = await session.state(queueReducer)
  const handed = offered.filter(({ head, lease }) => after.pending[head.id]?.lease?.id === lease)
  return handed.map(({ head, lease, attempt }) => ({ id: head.id, queue: head.queue, thread: head.thread, lease, attempt, event: head.event }))
}

/** Records how a pulled match went: done, skipped, or an error that waits, then tries again. */
export async function ack(
  session: QueueSession,
  id: string,
  body: { lease: string; error?: string | undefined; skip?: boolean | undefined },
  options: { now: number },
): Promise<'acked' | 'stale' | 'gone'> {
  const { state } = await session.state(queueReducer)
  const found = state.pending[id]
  if (!found) return 'gone'
  if (found.lease?.id !== body.lease) return 'stale'
  if (body.skip) {
    await session.append({ type: 'watch.skipped', payload: { matched: id, reason: 'its board skipped it' } })
    return 'acked'
  }
  if (body.error === undefined) {
    await session.append({ type: 'watch.acked', payload: { matched: id, lease: body.lease } })
    return 'acked'
  }
  const attempts = found.attempts + 1
  if (attempts >= MATCH_TRIES) {
    await session.append({ type: 'watch.acked', payload: { matched: id, lease: body.lease, error: body.error } }, failure(found, body.error))
    return 'acked'
  }
  const retryAt = options.now + retryDelay(attempts)
  await session.append({ type: 'watch.acked', payload: { matched: id, lease: body.lease, error: body.error, retryAt } })
  return 'acked'
}

/** Gives up on a match: `watch.failed`, said in the logs too. */
function failure(found: Pending, error: string): WatchInput {
  console.error(`[board] a registrant's ${found.queue} gave up on an item after ${MATCH_TRIES} tries:`, error)
  return { type: 'watch.failed', payload: { matched: found.id, thread: found.thread, error: describe(error) } }
}
