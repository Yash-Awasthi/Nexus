import type { BoardEventView, EventsPage, ParsedFilters } from '../api/routes.ts'
import { runMatch } from './watch-run.ts'

/** A pull with nothing to hand out holds this long: the same long-poll `vb tail` holds. */
const WAIT_S = 25
/** A run that throws waits this long, doubling to `RETRY_MAX_MS`, as on a local board. */
const RETRY_MS = 1000
const RETRY_MAX_MS = 30_000
/** A feed that fails is read again after this long, doubling to a minute. */
const READ_AGAIN_MS = 1000
const READ_AGAIN_MAX_MS = 60_000

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

export type TailOptions = {
  /** The watchers to run, by ID, each compiled: its filters, and whether it shows receipts. */
  watchers: Record<string, { filters: ParsedFilters; all: boolean }>
  /** One read of the feed, as `vb tail` makes it: from now without `after`, held up to `wait` seconds. */
  events(query: ParsedFilters & { all?: true; after?: string; wait: number }, signal: AbortSignal): Promise<EventsPage>
  /** Who watcher `id` writes as: an event by it never runs it, unless a schedule of its own posted it. */
  actorOf(id: string): Promise<string>
  /** Runs one watcher on an event; posts it makes get IDs derived from `trigger`. A throw is tried again. */
  run(id: string, event: BoardEventView, meta: { trigger: string; attempt: number }): Promise<void>
}

/**
 * Watchers run as tails in this process, for a board nothing can wake: each follows the feed from
 * the head, as `vb tail` does, and runs what it prints. A watcher sees a thread's events in order,
 * threads run side by side, and a `run` that throws waits 1 second, doubling to 30, until
 * `runMatch` gives up on it.
 */
export function tailWatchers(options: TailOptions) {
  let controller: AbortController | null = null
  const boot = crypto.randomUUID()
  let matched = 0

  async function follow(id: string, filters: ParsedFilters, all: boolean, signal: AbortSignal) {
    let own: string | undefined
    /** Each thread's runs, one after another. */
    const lanes = new Map<string, Promise<void>>()
    const query = { ...filters, ...(all ? { all: true as const } : {}) }
    let after: string | undefined
    for (let pause = READ_AGAIN_MS; !signal.aborted; ) {
      let page: EventsPage
      try {
        own ??= await options.actorOf(id)
        // The first read only finds the head: a watcher sees what comes after it starts.
        page = await options.events(after === undefined ? { ...query, wait: 0 } : { ...query, after, wait: WAIT_S }, signal)
        pause = READ_AGAIN_MS
      } catch (error) {
        if (signal.aborted) return
        console.error(`[board] watcher ${id} couldn't read the board:`, describe(error))
        await sleep(pause, signal)
        pause = Math.min(pause * 2, READ_AGAIN_MAX_MS)
        continue
      }
      after = page.cursor
      for (const event of page.events) {
        // Its own writes never wake it, but for what a schedule of its own posted: that's how it asks to be woken later.
        if (event.actor?.id === own && !(event.type === 'message.posted' && event.message?.schedule)) continue
        const thread = event.message?.thread ?? ''
        const match = { id: `${boot}:${matched++}`, payload: { thread, event } }
        const lane = (lanes.get(thread) ?? Promise.resolve()).then(() => attempts(id, match, signal))
        lanes.set(thread, lane)
        void lane.then(() => {
          if (lanes.get(thread) === lane) lanes.delete(thread)
        })
      }
    }
  }

  async function attempts(id: string, match: { id: string; payload: { thread: string; event: BoardEventView } }, signal: AbortSignal) {
    const trigger = `watch:${id}:${match.id}`
    for (let attempt = 1, wait = RETRY_MS; !signal.aborted; attempt++, wait = Math.min(wait * 2, RETRY_MAX_MS)) {
      try {
        // Its failure is logged, as on a local board: there's no log here to record it in.
        await runMatch({ watcher: { id, run: (event) => options.run(id, event, { trigger, attempt }) }, match, attempt, record: async () => {} })
        return
      } catch (error) {
        console.error(`[board] watcher ${id} failed:`, error)
        await sleep(wait, signal)
      }
    }
  }

  return {
    /** Starts every watcher's tail, once. */
    start() {
      if (controller) return
      const { signal } = (controller = new AbortController())
      for (const [id, { filters, all }] of Object.entries(options.watchers)) void follow(id, filters, all, signal)
    },
    /** Stops every tail, and the retries waiting. */
    close() {
      controller?.abort()
      controller = null
    },
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })
