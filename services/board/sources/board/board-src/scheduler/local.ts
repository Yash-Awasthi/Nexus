import {
  deliverSchedulerAppend,
  deliverSchedulerClear,
  type A2Scheduler,
  type DrainableServer,
  type SchedulerTask,
} from 'experimental-a2/server'

/** The longest delay a timer takes: past it, `setTimeout` fires at once. */
const MAX_DELAY = 2 ** 31 - 1

/**
 * A scheduler in this process, `local()`'s: each task runs at its time on a timer, so retries,
 * leases, wake-ups, and scheduled messages work with nothing else running. Its timers live in the
 * process, and a restart drops the pending ones, so it's for development, `vb serve`, tests, and
 * long-running servers, never serverless functions, which stop between requests.
 */
/** The local scheduler, which `stop()` stops: its timers cleared, nothing pending. */
export type LocalScheduler = A2Scheduler & { stop(): void }

export function localScheduler(): LocalScheduler {
  let servers: readonly DrainableServer[] = []
  // The same task asked for twice runs once, as a queue's deduplication would.
  const pending = new Set<string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false

  async function run(task: SchedulerTask) {
    const server = servers.find((candidate) => candidate.contract.name === task.contract)
    if (!server) throw new Error(`no server for contract ${task.contract}: mount it with scheduler.handler(...)`)
    if (task.kind === 'drain') await server.drain(task.sessionId)
    else if (task.kind === 'append') await deliverSchedulerAppend(server, task)
    else await deliverSchedulerClear(server, task)
  }

  return {
    async schedule(task) {
      // Once stopped, what's asked for stays in the log: whoever opens it next catches up.
      if (stopped) return
      const key = task.kind === 'drain' ? `drain\u001f${task.contract}\u001f${task.sessionId}\u001f${task.dueAt}` : task.id
      if (pending.has(key)) return
      pending.add(key)
      // A task more than a timer's longest delay out (about 24.8 days) waits that long, then again.
      const arm = () => {
        const wait = task.dueAt - Date.now()
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (wait > MAX_DELAY) return arm()
          pending.delete(key)
          // A failed drain is A2's to retry on the next write; here it's only said.
          run(task).catch((error) => console.error('[board] a scheduled task failed:', error))
        }, Math.min(Math.max(0, wait), MAX_DELAY))
        timers.add(timer)
        // A pending timer doesn't keep the process alive: a dev server's own socket does that.
        timer.unref?.()
      }
      arm()
    },
    stop() {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
    handler(...mounted) {
      servers = mounted
      // Nothing calls it: tasks never leave this process.
      return async () => new Response(null, { status: 204 })
    },
  }
}
