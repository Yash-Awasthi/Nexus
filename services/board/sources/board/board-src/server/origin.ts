// Where a write comes from and how to answer it, as a backend receives it: no write path here,
// so the protocol's types can name it without loading the local board's engine.
import type { WriteSource } from './middleware.ts'

/**
 * Where a write came from: `middleware` is the middleware's own client, which skips it, and
 * `engine` is sync's own lookups and receipts.
 */
export type Via = WriteSource | { kind: 'middleware' } | { kind: 'engine' }

/**
 * How a write reaches the middleware: where it's from, and how to answer there. `schedule` marks a
 * schedule's send, which a backend's own schedules set in-process: no request carries it.
 */
export type WriteOrigin = {
  via?: Via
  respond?: (text: string) => Promise<void>
  schedule?: { id: number; n: number }
}

/**
 * Sync in board() itself, on a board whose log is in this deployment (`local()`): it checked each
 * platform event itself, so what it imports is by the platform user, not a profile of anyone.
 */
export const SYNC_ACTOR = 'board:sync'
