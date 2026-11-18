import { A2Error, idempotentId } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import type { BoardEventView } from '../api/routes.ts'
import type { Watcher, WatcherContext } from './watcher.ts'
import type { Board } from './board.ts'
import { boardContract, watchContract, watchSession } from '../contract/contract.ts'
import type { BoardEvent, BoardEvents } from '../contract/events.ts'
import { actorsReducer } from '../contract/reducers.ts'
import type { Message, MessagesState } from '../contract/folds.ts'
import { FULL_ACCESS, type Access } from './access.ts'
import { compileFilter, eventView, foldEvent, loadBefore, OWN_CODE, view as messageView } from './feed.ts'
import { compileWatcher, type Compiled } from './watch-spec.ts'
import type { BoardReads } from './reads.ts'
import type { Registration, RegistryState, StoredPrincipal } from './registry.ts'
import { runMatch } from './watch-run.ts'


export const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The events a tail shows, receipts and a claim's renewals included for `--all`: each concerns a message, and carries its thread for the lane. */
const WATCHED = [
  'message.posted',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'labels.changed',
  'message.sync_failed',
  'message.synced',
  'message.files_synced',
  'thread.synced',
  'task.created',
  'task.assigned',
  'task.needs_changed',
  'task.ready',
  'task.claimed',
  'task.renewed',
  'task.released',
  'task.expired',
  'task.completed',
  'task.failed',
  'task.blocked',
  'task.unblocked',
  'task.canceled',
  'task.reopened',
] as const

/** Receipts and a claim's renewals: only a `--all` tail shows them. */
const RECEIPTS = new Set(['message.synced', 'message.files_synced', 'task.renewed'])

/**
 * What a registrant's sync gets, in every channel where it may sync: what it delivers to platforms,
 * and a thread's new targets. A tail never shows `thread.synced`, so no watcher gets it.
 */
const SYNCED = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'thread.synced'])

/** A watcher writes as `board:watch:<id>`, and its own writes never wake it, but for a schedule's sends. */
const actorOf = (id: string) => `board:watch:${id}`

export { compileWatcher }

/** A watcher to match an event against: one in config, or one registered here. */
type Candidate = Compiled & {
  id: string
  /** Who its writes are by: an event by it never wakes it, unless a schedule of its own posted it. */
  actor: string
  /** A registered one's registration, whose principal decides what it may see. Config ones see everything. */
  registration?: Registration
}

/** `watch:@<principal>`: everything one registrant's watchers matched, queued for it to pull. */
export const registrantSession = (owner: string) => watchSession(`@${owner}`)

/**
 * Watchers: a board-contract consumer matches each event against every
 * watcher's filters, the way a tail does, and appends what matched to that
 * watcher's session, where `run` happens on the thread's lane.
 */
export function createWatchers(options: {
  /** This project's watchers, by ID. */
  watch: Record<string, { tail: string }>
  /** Runs one on an event it matched; posts it makes get IDs derived from `trigger`. A throw is retried. */
  run: (id: string, event: BoardEventView, trigger: string, attempt: number) => Promise<void>
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
  /** Watchers registered here, whose matches queue for their registrant to pull. */
  registered?: {
    state: () => Promise<RegistryState>
    /** What a registrant may do now, under the rules as they are: null once it may do nothing. */
    accessNow: (principal: StoredPrincipal) => Promise<Access | null>
  }
}) {
  const watchers = Object.entries(options.watch).map(([id, watcher]) => {
    if (!ID.test(id)) throw new Error(`watch: ids use lowercase letters, numbers, - and _, got: ${id}`)
    return { id, ...compileWatcher(id, watcher) }
  })
  const byId = new Map(watchers.map((watcher) => [watcher.id, watcher]))

  let reads: BoardReads | null = null

  /** Runs a watcher on a board event it matched, one thread at a time. */
  const runner = consumer({
    contract: watchContract,
    name: 'board-watch',
    types: ['watch.matched'],
    lane: ({ event }) => `thread:${event.payload.thread}`,
  }).run(async (ctx) => {
    // A registered watcher's matches are its registrant's to pull; a config watcher removed
    // since it matched has nothing left to run.
    const watcher = byId.get(ctx.session.id.slice('watch:'.length))
    if (!watcher) return
    await runMatch({
      watcher: { id: watcher.id, run: (event) => options.run(watcher.id, event, ctx.event.id, ctx.attempt) },
      match: ctx.event,
      attempt: ctx.attempt,
      record: (payload) => ctx.session.append(`failed:${ctx.event.id}`, { type: 'watch.failed', payload }),
    })
  })

  const server = createServer({
    contract: watchContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [runner],
  })

  const configured: Candidate[] = watchers.map((watcher) => ({ ...watcher, actor: actorOf(watcher.id) }))
  // Each registration's tails, parsed once per hash and principal.
  const compiled = new Map<string, { version: string; candidates: Candidate[] }>()
  function compiledFor(registration: Registration): Candidate[] {
    // A new principal changes what it may see, so it compiles again too.
    const version = `${registration.hash}\u001f${JSON.stringify(registration.principal)}`
    const hit = compiled.get(registration.owner)
    if (hit?.version === version) return hit.candidates
    const candidates: Candidate[] = []
    for (const [id, spec] of Object.entries(registration.watch)) {
      try {
        candidates.push({ ...compileWatcher(id, spec), id, actor: `${registration.owner}+${id.toLowerCase()}`, registration })
      } catch (error) {
        // Checked when it was registered: only a tail this version reads differently gets here.
        console.error(`[board] skipping a watcher ${registration.owner} registered:`, (error as Error).message)
      }
    }
    compiled.set(registration.owner, { version, candidates })
    return candidates
  }
  async function registrations(): Promise<Registration[]> {
    return options.registered ? Object.values((await options.registered.state()).byOwner) : []
  }

  /** Matches one board event; the message before or after it must match, as in a tail. */
  async function dispatch(ctx: ConsumerContext<BoardEvents>) {
    const event = ctx.event as BoardEvent
    const through = event.index - 1
    const [messages, { state: actors }] = await Promise.all([
      messagesBefore(event, ctx.signal),
      ctx.session.state(actorsReducer, { through }),
    ])
    const { id, before, after } = foldEvent(messages, actors, event)
    const by = (event.payload as { by?: { actor?: string } }).by?.actor
    // A schedule's send is how a watcher asks to be woken later: its own still wakes it.
    const scheduled = event.type === 'message.posted' && event.payload.schedule !== undefined
    const message = after ?? before
    const thread = (event.payload as { thread: string }).thread
    let view: BoardEventView | undefined
    /** Each session's matches, appended together: one append per watcher in config, one per registrant. */
    const appends = new Map<string, { type: 'watch.matched'; id: string; payload: { thread: string; event: unknown; watcher?: string; sync?: true } }[]>()
    const add = (session: string, matched: { type: 'watch.matched'; id: string; payload: { thread: string; event: unknown; watcher?: string; sync?: true } }) =>
      (appends.get(session) ?? appends.set(session, []).get(session)!).push(matched)
    const registered = await registrations()
    const targets = [...configured, ...registered.flatMap(compiledFor)]
    // Each registrant's access, worked out once per event.
    const registrants = new Map<string, Promise<Access | null>>()
    const accessOf = (registration: Registration) => {
      let found = registrants.get(registration.owner)
      if (!found) registrants.set(registration.owner, (found = options.registered!.accessNow(registration.principal)))
      return found
    }
    for (const watcher of targets) {
      if (event.type === 'thread.synced') break
      if (by === watcher.actor && !scheduled) continue
      if (RECEIPTS.has(event.type) && !watcher.all) continue
      const { registration } = watcher
      let access: Access = FULL_ACCESS
      if (registration) {
        const now = await accessOf(registration)
        // A registered watcher sees what its registrant may read, as `/events` shows it: an event
        // about a message only where it reads the message's channel, one about none only if it reads all.
        if (!now || (id === null ? !now.readsAll : !message || !now.readable(message.channel))) continue
        access = now
      }
      const match = compileFilter(watcher.filters, { me: null, actors, messages, access })
      if (!(watcher.criteria ? match(before) || match(after) : id !== null)) continue
      const key = registration ? `@${registration.owner}/${watcher.id}` : watcher.id
      const shown = registration
        ? eventView(event, after, actors, await reads!.reader(access, after ? [after] : []))
        : (view ??= eventView(event, after, actors, OWN_CODE))
      const session = registration ? registrantSession(registration.owner) : watchSession(watcher.id)
      add(session, {
        type: 'watch.matched',
        id: await idempotentId('board-watch', key, event.id),
        payload: { thread, event: shown, ...(registration ? { watcher: watcher.id } : {}) },
      })
    }
    // A registrant's sync, in the channels where it may sync: a thread's sync is about its root.
    const syncing = SYNCED.has(event.type) ? registered.filter((registration) => registration.sync.length > 0) : []
    if (syncing.length > 0) {
      const about = event.type === 'thread.synced' ? await rootOf(event.payload.thread, event.index, ctx.signal) : message
      for (const registration of syncing) {
        const now = await accessOf(registration)
        if (!now || !about || !now.can('sync', about.channel)) continue
        const reader = await reads!.reader(now, [about, ...(before ? [before] : [])])
        // A label change re-renders a copy only when the labels change what it shows: sync compares them.
        const shown = { ...eventView(event, about, actors, reader), ...(event.type === 'labels.changed' && before ? { before: messageView(before, actors, reader) } : {}) }
        add(registrantSession(registration.owner), {
          type: 'watch.matched',
          id: await idempotentId('board-watch', `@${registration.owner}/@sync`, event.id),
          payload: { thread, event: shown, sync: true },
        })
      }
    }
    await Promise.all(
      [...appends].map(async ([session, events]) => {
        try {
          await server.session(session).append(...events)
        } catch (error) {
          // A retry after a registration changed brings matches the first try didn't: each on its own.
          if (!(error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH')) throw error
          for (const matched of events) await server.session(session).append(matched)
        }
      }),
    )
  }

  /** A thread's root, as the board has it once the tables reach `index`: the event that synced it comes after it. */
  async function rootOf(thread: string, index: number, signal: AbortSignal): Promise<Message | undefined> {
    if (!reads) throw new Error('watchers used before the board bound them')
    await reads.ensure(index - 1, signal)
    return (await reads.tables.byEventId(thread)) ?? undefined
  }

  /** The message `event` concerns, and its thread's root, as they were just before it. */
  async function messagesBefore(event: BoardEvent, signal: AbortSignal): Promise<MessagesState> {
    if (!reads) throw new Error('watchers used before the board bound them')
    return loadBefore(reads, event, signal)
  }

  /**
   * Matches board events against the watchers, on the same per-thread lanes as
   * sync's but with its own place in the log: a watcher that fails holds up
   * neither sync nor any other thread.
   */
  const boardConsumer = consumer({
    contract: boardContract,
    name: 'board-watchers',
    types: WATCHED,
    lane: ({ event }) => `thread:${(event.payload as { thread: string }).thread}`,
  }).run(dispatch)

  return {
    server,
    boardConsumer,
    bind: (binding: { reads: BoardReads }) => {
      reads = binding.reads
    },
  }
}
