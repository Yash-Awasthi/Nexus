import type { BoardClient } from '../client/client.ts'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import type { ProviderEvent, SyncOverrides, SyncResult } from './events.ts'
import { channelMissing, type Renderer } from './provider.ts'

/** An event coming in from the platform. */
export type SyncIn<E extends ProviderEvent = ProviderEvent> = {
  direction: 'in'
  /** The sync entry's key: `slack` in `sync: { slack: slack(…) }`. */
  key: string
  /** The platform channel it happened in, as the platform names it: `C0123ABC`, `owner/repo:pulls`, a phone number ID. */
  channel: string
  /** The event, validated and frozen. */
  event: E
  /** The board, as the platform user the event came from: its writes are theirs. */
  board: BoardClient
  /**
   * Imports the event: into its board thread when the board syncs its platform thread, otherwise
   * as a new root in `channel`. Without a channel, an event in a thread the board doesn't sync
   * stays off it. Runs once: a second call answers what the first did.
   */
  import(channel?: string, overrides?: SyncOverrides): Promise<SyncResult>
  /** The platform's own link to the event's message, or null when it has none. Nothing is synced or joined. */
  permalink(): Promise<string | null>
  /** A platform channel's ID from its name (`#dev` → `C0123ABC`), as `channel` names it. */
  resolve(name: string): Promise<string>
}

/** A board event going out to the platform. */
export type SyncOut = {
  direction: 'out'
  key: string
  /** The platform channel `target` is in, as the platform names it; null for a new root, which isn't on the platform yet. */
  channel: string | null
  event: BoardEventView
  /** The message the event is about, as it is now. */
  message: MessageView
  /** Where it goes: a platform thread or channel the board thread syncs with (`slack:C0123ABC:1727000000.123456`), or null for a new root. */
  target: string | null
  /**
   * Sends the event to `target`: a new thread's root and what's been said in it, a reply, an
   * edit, a delete, a reaction, or the copy a label change re-renders. A new root has no target
   * yet, so it sends nothing. Runs once: a second call answers what the first did.
   */
  deliver(options?: { render?: Renderer }): Promise<void>
  /**
   * Syncs the message's thread with a platform channel (`#dev`, `C0123ABC`): the board starts a
   * thread there, and its root and replies follow. Never the channel it came from.
   */
  start(channel: string): Promise<void>
  resolve(name: string): Promise<string>
}

export type Sync<E extends ProviderEvent = ProviderEvent> = SyncIn<E> | SyncOut

/**
 * What every event does, both ways. Inbound, it calls `import` to bring the event onto the board;
 * outbound, `deliver` to send it to the platform, or `start` to open a new root's thread there.
 * One that calls neither does nothing. A throw is retried.
 *
 * The webhook keeps an event (stores it in the inbox for the function) when the board syncs its
 * thread, or when its channel is one that `channels`, `repos`, or `numbers` routes. A function of
 * your own at the top keeps every event the platform sends, so keep the helper outermost.
 */
export type SyncFn<E extends ProviderEvent = ProviderEvent> = (sync: Sync<E>) => unknown

/** Whether a helper's function routes a platform channel, which the webhook keeps events for. */
export type Routes = (channel: string, resolve: (name: string) => Promise<string>) => Promise<boolean>
const ROUTES = Symbol.for('board.syncRoutes')

/** A helper's function, marked with the channels it routes. */
export function withRoutes<F extends (sync: never) => unknown>(fn: F, routes: Routes): F {
  Object.defineProperty(fn, ROUTES, { value: routes, enumerable: false, configurable: true })
  return fn
}

/** The channels a helper's function routes; undefined for a function of your own, which keeps everything. */
export const routesOf = (fn: (sync: never) => unknown): Routes | undefined => (fn as { [ROUTES]?: Routes })[ROUTES]

/** A sync function, or a board channel: what a string means is up to the helper that takes it. */
export type SyncUnit<E extends ProviderEvent = ProviderEvent> = string | SyncFn<E>

/**
 * A two-way mirror of a board channel: what comes in lands in `channel`, what's said on the
 * board goes out, and a new root in `channel` starts a thread in the platform channel.
 */
export function mirror(channel: string): SyncFn {
  return async (sync) => {
    if (sync.direction === 'in') return void (await sync.import(channel))
    if (sync.target !== null) return sync.deliver()
    if (sync.channel !== null && sync.message.channel === channel) await sync.start(sync.channel)
  }
}

/** Imports into a board channel, and sends nothing back. */
export function into(channel: string): SyncFn {
  return async (sync) => {
    if (sync.direction === 'in') await sync.import(channel)
  }
}

/** `inner`, delivering with `renderer` unless it passes its own. */
export function render<E extends ProviderEvent = ProviderEvent>(renderer: Renderer, inner: SyncFn<E>): SyncFn<E> {
  const fn: SyncFn<E> = (sync) =>
    inner(sync.direction === 'in' ? sync : { ...sync, deliver: (options = {}) => sync.deliver({ render: renderer, ...options }) })
  const routes = routesOf(inner)
  return routes ? withRoutes(fn, routes) : fn
}

/** What a thread the board syncs does outside the mapped channels: it stays synced, both ways. */
const follow = async (sync: Sync) => {
  if (sync.direction === 'in') await sync.import()
  else await sync.deliver()
}

/**
 * Routes each event by its platform channel. Keys are platform channels, by name (`'#dev'`) or
 * ID (`'C0123ABC'`); values are a board channel to `mirror`, or a sync function. A new root goes
 * to every channel's function, with `channel` set to that one. A thread the board syncs outside
 * these channels (someone ran `vb sync` on it) stays synced both ways. A key the platform says
 * doesn't exist is skipped. While one can't be checked, an event outside the resolved channels
 * that it may be (any, for a name; its own, for an ID) throws, so it's retried, rather than
 * going past that key's function to the default. The webhook keeps one an ID may be; one only a
 * name may be, it refuses, so the platform sends it again and nothing off the map is stored. A
 * new root starts only in the channels that resolved.
 */
export function channels<E extends ProviderEvent = ProviderEvent>(map: Record<string, SyncUnit<E>>): SyncFn<E> {
  const units = Object.entries(map).map(([name, unit]) => [name, typeof unit === 'string' ? mirror(unit) : unit] as const)
  const resolved = async (resolve: (name: string) => Promise<string>) => {
    const ids = await Promise.allSettled(units.map(([name]) => resolve(name)))
    const found = new Map<string, SyncFn<E>>()
    const unchecked: { key: string; reason: unknown }[] = []
    ids.forEach((id, i) => {
      if (id.status === 'fulfilled') found.set(id.value, units[i]![1])
      else if (!channelMissing(id.reason)) unchecked.push({ key: units[i]![0], reason: id.reason })
    })
    // A name (`#support`) that couldn't be checked may be any channel; an ID only itself.
    const pending = (channel: string) =>
      unchecked.find(({ key }) => key.toLowerCase() === channel.toLowerCase()) ?? unchecked.find(({ key }) => key.startsWith('#'))
    return { found, pending }
  }
  const fn: SyncFn<E> = async (sync) => {
    const { found, pending } = await resolved(sync.resolve)
    if (sync.direction === 'out' && sync.target === null) {
      for (const [channel, unit] of found) await unit({ ...sync, channel })
      return
    }
    const unit = found.get(sync.channel!)
    if (unit) return void (await unit(sync))
    // A key that couldn't be checked may be this channel: its function decides once it resolves.
    const unchecked = pending(sync.channel!)
    if (unchecked) throw unchecked.reason
    await follow(sync)
  }
  // An event an ID that couldn't be checked may route is kept: the function decides once it
  // resolves. One only a name may route throws: the webhook refuses it, and the platform sends it
  // again, rather than storing every channel's events while the name is unknown.
  return withRoutes(fn, async (channel, resolve) => {
    const { found, pending } = await resolved(resolve)
    if (found.has(channel)) return true
    const unchecked = pending(channel)
    if (!unchecked) return false
    if (unchecked.key.startsWith('#')) throw unchecked.reason
    return true
  })
}
