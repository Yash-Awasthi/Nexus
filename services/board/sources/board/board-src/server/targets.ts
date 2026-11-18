import { isThreadTarget } from '../contract/external.ts'

/** A sync target, resolved: a platform channel to start a thread in, or a thread to join. */
export type SyncTarget = { target: string; kind: 'channel' | 'thread' }

/** A target as a post or a receipt names it, resolved: a plain one's kind goes by its shape. */
export const syncTarget = (target: string | SyncTarget): SyncTarget =>
  typeof target === 'string' ? { target, kind: isThreadTarget(target) ? 'thread' : 'channel' } : target
