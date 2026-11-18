import type { MatchView, RegistrationView } from '../api/routes.ts'
import type { BackendRoute, BoardBinding, Caller } from './backend.ts'
import { json } from './errors.ts'
import { waitUntil } from './wait-until.ts'

/** Registering again this soon after the same registration only repeats it. */
const REGISTER_EVERY_MS = 10_000
/** How long one wake-up runs matches before it leaves the rest to the next. */
const DRAIN_MS = 4 * 60_000
/** How long a wake-up waits for what it pulled to run before it answers: under the 3 seconds Vercel's API gives it. */
const WAKE_ANSWER_MS = 2000
/** A pull with nothing to hand out holds this long, when the board pulls on its own. */
const POLL_WAIT_S = 25

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

/** Only an https URL can be woken; anything else pulls on its own. */
export const wakeable = (here: string | null) => (here?.startsWith('https://') ? here : null)

/** Whether a registration is woken at all: one with no path pulls on its own, off Vercel. */
const pulls = (registration: RegistrationView) => registration.path === undefined

/**
 * Whether this is a deployment on Vercel, whose function doesn't outlive its request: `VERCEL` is 1,
 * outside development. `vercel env pull` and `vercel dev` set both for a dev server, which stays up.
 */
export const deployedOnVercel = () => typeof process !== 'undefined' && process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'development'

/** Where Vercel's API wakes this board: a path on this Vercel project, or none to pull on its own. */
export type WakeAt = { path?: undefined } | { path: string; branch?: string }

/**
 * A path on this Vercel project for a board that wakes by path, from `here`, this board's URL: from
 * every deployment on Vercel, whose environment the board that wakes it finds from its token. A
 * preview of a branch names it. Null anywhere else, a dev server included, where only a URL wakes it.
 */
export function wakePath(here: string | null): { path: string; branch?: string } | null {
  if (!here || !deployedOnVercel()) return null
  const env = process.env
  // A custom environment says `preview` in VERCEL_ENV and its own name in VERCEL_TARGET_ENV.
  const environment = env.VERCEL_TARGET_ENV || env.VERCEL_ENV
  const branch = environment === 'preview' ? env.VERCEL_GIT_COMMIT_REF || null : null
  return { path: new URL(here).pathname, ...(branch ? { branch } : {}) }
}

/** What a board that keeps nothing asks of the board that matches its watchers, as itself. */
export type Registry = {
  /** Registers this board's own watchers and sync entries there, woken at `where`, replacing its last registration. */
  register(where: WakeAt): Promise<RegistrationView>
  matches(options: { limit: number; wait?: number; signal?: AbortSignal }): Promise<MatchView[]>
  ack(id: string, body: { lease: string; error?: string; skip?: boolean }): Promise<unknown>
}

export type RegistrantOptions = {
  /** The other board, as what this one logs names it. */
  remote: string
  registry: Registry
  /** Where the other board wakes this one, from this board's URL. */
  wakeAt(here: string | null): Promise<WakeAt>
  binding(): BoardBinding
  /** What every wake-up carries, so this board can tell the other holds an older registration. */
  hash(): Promise<string>
  /** Whether there's anything to register: watchers, or sync entries. */
  hasWork(): boolean
  /** The other board's error, as this board answers it. */
  rethrow(error: unknown): never
  /** `POST /watchers` from a caller board() verified: a registration of its own, the backend's to make. */
  registerFor(caller: Caller, request: Request): Promise<Response>
}

/**
 * Runs a deployment's watchers on Vercel's API, which matches them: it registers them there, is
 * woken at its path when one matches, with nothing in the wake-up but a hash, and pulls what
 * matched with its own credentials, runs it, and acks it. With no path to wake (a dev server, say),
 * it pulls on its own. vercel() runs a deployment's watchers this way.
 */
export function registrant(options: RegistrantOptions) {
  const { registry, rethrow } = options
  const bound = options.binding

  let last: { url: string | null; at: number; result: RegistrationView } | null = null
  let registering: Promise<RegistrationView> | null = null
  /**
   * Registers this board's watchers with the other board, as itself, replacing its last registration. `fresh`
   * registers again even so soon after the same one: the other board said something changed since (another
   * deployment took a sync key), and only a new answer says what.
   */
  async function register(here: string | null, fresh = false): Promise<RegistrationView> {
    const current = await options.hash()
    if (!fresh && last && last.url === here && last.result.hash === current && Date.now() - last.at < REGISTER_EVERY_MS) return last.result
    // One already on its way was sent before what changed.
    if (fresh && registering) await registering.catch(() => {})
    registering ??= options
      .wakeAt(here)
      .then((where) => registry.register(where))
      .then((result) => {
        last = { url: here, at: Date.now(), result }
        return result
      })
      .finally(() => {
        registering = null
      })
    return registering
  }

  /** Runs one match and acks it: done, its error, or a skip for a watcher this board no longer has. */
  async function runOne(match: MatchView) {
    let outcome: { error?: string; skip?: boolean } = {}
    if (!bound().subscriptions[match.watcher]) outcome = { skip: true }
    else
      try {
        await bound().run(match.watcher, match.event, { trigger: `watch:${match.watcher}:${match.id}`, attempt: match.attempt + 1 })
      } catch (error) {
        console.error(`[board] watcher ${match.watcher} failed:`, error)
        outcome = { error: describe(error) }
      }
    // A lease that ran out was pulled again: that pull's ack is the one that counts.
    await registry.ack(match.id, { lease: match.lease, ...outcome }).catch((error) => console.error(`[board] couldn't ack a match:`, describe(error)))
  }

  /**
   * Pulls and runs what's matched until nothing's left, or this run's time is up, and what sync
   * queued in its inbox. A thread's matches come one at a time.
   */
  async function drain(): Promise<number> {
    let ran = 0
    const until = Date.now() + DRAIN_MS
    while (Date.now() < until) {
      const matches = await registry.matches({ limit: 10 })
      if (matches.length === 0) break
      // Each is a different watcher's or thread's oldest, so they run side by side.
      await Promise.all(matches.map(runOne))
      ran += matches.length
    }
    // An inbox event whose wait after an error is over: what woke this board may be it.
    return ran + (await bound().pull())
  }

  let polling: AbortController | null = null
  /** For a board that can't be woken: pulls on its own, each pull held open until something matches. */
  function poll() {
    if (polling || deployedOnVercel()) return
    const controller = (polling = new AbortController())
    void (async () => {
      for (let pause = 1000; !controller.signal.aborted; ) {
        try {
          await register(null)
          const matches = await registry.matches({ limit: 10, wait: POLL_WAIT_S, signal: controller.signal })
          await Promise.all(matches.map(runOne))
          // Sync's inbox too: an event that failed tries again once its wait is over.
          await bound().pull()
          pause = 1000
        } catch (error) {
          if (controller.signal.aborted) break
          console.error(`[board] couldn't pull matches from ${options.remote}:`, describe(error))
          await new Promise((resolve) => setTimeout(resolve, pause))
          pause = Math.min(pause * 2, 60_000)
        }
      }
    })()
  }

  let started: Promise<void> | null = null
  let failedAt = 0
  /**
   * On first use, a board with watchers or sync registers them if it knows its URL. One on Vercel
   * learns its mount path from a request (a `POST /watchers`, a webhook, or a wake-up); one that
   * can't be woken registers without one and pulls instead. Resolves once the first try is done.
   * One that fails tries again on a later use, at most every `REGISTER_EVERY_MS`: nothing would
   * wake a board the other doesn't know.
   */
  function start(): Promise<void> {
    if (started) return started
    if (!options.hasWork() || Date.now() - failedAt < REGISTER_EVERY_MS) return Promise.resolve()
    const here = wakeable(bound().url())
    if (!here && deployedOnVercel()) return Promise.resolve()
    started = register(here).then(
      (registration) => {
        if (pulls(registration)) poll()
      },
      (error: unknown) => {
        started = null
        failedAt = Date.now()
        console.error(`[board] couldn't register with ${options.remote}:`, describe(error))
      },
    )
    if (!here) poll()
    return started
  }

  const routes: BackendRoute[] = [
    {
      // Nothing in a wake-up is trusted: it only says to pull, and what's pulled comes with this board's own credentials.
      // A drain runs as long as the watchers do, and whoever woke it gives up within seconds: past a short wait, it answers
      // 202 and keeps running. Until then the waker holds its next wake-up, so a burst still wakes it once.
      method: 'POST',
      path: '/wake',
      async handle(request) {
        started ??= Promise.resolve()
        const stale = request.headers.get('x-board-watchers') !== (await options.hash())
        const running = (async () => {
          if (stale) await register(wakeable(bound().url()))
          return drain()
        })()
        waitUntil(running.catch((error: unknown) => console.error(`[board] couldn't run what woke it:`, describe(error))))
        let timer: ReturnType<typeof setTimeout> | undefined
        const waited = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), WAKE_ANSWER_MS)))
        try {
          const ran = await Promise.race([running.catch(rethrow), waited])
          return ran === null ? new Response(null, { status: 202 }) : json({ ran })
        } finally {
          clearTimeout(timer)
        }
      },
    },
    {
      // Anyone may ask: it sends this board's own watchers, with this board's own credentials. A
      // handle here registers its own, on the other board, as the protocol's route does.
      method: 'POST',
      path: '/watchers',
      async handle(request, { caller }) {
        if (caller) return options.registerFor(caller, request)
        started ??= Promise.resolve()
        const here = wakeable(bound().url())
        const registration = await register(here).catch(rethrow)
        if (!here || pulls(registration)) poll()
        return json(registration)
      },
    },
  ]

  return {
    start,
    routes,
    /** Registers this board's watchers with the other board now, as `POST /watchers` does, and with `fresh`, even if it just did. */
    registerNow: (fresh = false) => register(wakeable(bound().url()), fresh),
    /** Stops pulling, for a board that pulls on its own. */
    close: () => {
      polling?.abort()
      polling = null
    },
  }
}
