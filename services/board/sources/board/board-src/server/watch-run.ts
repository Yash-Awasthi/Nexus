import type { BoardEventView } from '../api/routes.ts'
import { A2_TRIES, afterRetry } from './attempts.ts'

/**
 * A2 dead-letters an event after 10 failures, and a dead letter stops its
 * lane, which is the thread's: the watcher would never run on that thread
 * again. So `run` gets a few tries, then the failure is recorded and the
 * thread moves on.
 */
const RUN_ATTEMPTS = 5

/**
 * A run that's killed (a timeout, out of memory) never throws. A2 counts it
 * toward the 10 failures when the next attempt takes over, and dead-letters
 * the event at that takeover instead of running it: the 10th attempt is the
 * last one a watcher sees. Throws give up at RUN_ATTEMPTS, so getting this far
 * means runs keep dying, and the 10th records the failure without running.
 */
const KILLED_ATTEMPTS = A2_TRIES

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

type Match = { id: string; payload: { thread: string; event: unknown } }

/**
 * One match, on its thread's lane: `run`, retried while it fails (by A2 on a local board, by the
 * tail on a person's Vercel board), then given up on and recorded so the thread's next event runs.
 */
export async function runMatch(input: {
  watcher: { id: string; run: (event: BoardEventView) => unknown }
  match: Match
  attempt: number
  record: (failure: { matched: string; thread: string; error: string }) => Promise<unknown>
}) {
  const { watcher, match, attempt } = input
  const event = match.payload.event as BoardEventView
  const giveUp = async (error: string) => {
    console.error(`[board] watcher ${watcher.id} gave up on event #${event.cursor} after ${attempt} tries:`, error)
    await input.record({ matched: match.id, thread: match.payload.thread, error })
  }
  const early = !afterRetry(attempt)
  if (early && attempt >= KILLED_ATTEMPTS) return giveUp(`its run was cut short ${attempt - 1} times (a timeout, or out of memory)`)
  try {
    await watcher.run(event)
  } catch (error) {
    if (!early || attempt < RUN_ATTEMPTS) throw error
    await giveUp(describe(error))
  }
}
