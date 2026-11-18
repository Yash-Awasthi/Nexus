import type { Lock, QueueEntry, StateAdapter } from 'chat'

/**
 * Chat SDK state for sync. Correctness comes from the board log (deterministic
 * inbox IDs, the `sync` reducer), and Chat SDK runs with `concurrency:
 * 'concurrent'` and no subscriptions, so this only holds best-effort caches.
 */
export function ephemeralState(): StateAdapter {
  const values = new Map<string, { value: unknown; expiresAt: number }>()
  const lists = new Map<string, unknown[]>()
  const queues = new Map<string, QueueEntry[]>()
  const locks = new Map<string, Lock>()
  const subscriptions = new Set<string>()
  const live = (key: string) => {
    const entry = values.get(key)
    if (entry && entry.expiresAt <= Date.now()) values.delete(key)
    return values.get(key)
  }
  const expiry = (ttlMs?: number) => (ttlMs ? Date.now() + ttlMs : Number.POSITIVE_INFINITY)

  return {
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async (threadId) => void subscriptions.add(threadId),
    unsubscribe: async (threadId) => void subscriptions.delete(threadId),
    isSubscribed: async (threadId) => subscriptions.has(threadId),
    acquireLock: async (threadId, ttlMs) => {
      const held = locks.get(threadId)
      if (held && held.expiresAt > Date.now()) return null
      const lock: Lock = { threadId, token: crypto.randomUUID(), expiresAt: Date.now() + ttlMs }
      locks.set(threadId, lock)
      return lock
    },
    extendLock: async (lock, ttlMs) => {
      const held = locks.get(lock.threadId)
      if (held?.token !== lock.token) return false
      held.expiresAt = Date.now() + ttlMs
      return true
    },
    releaseLock: async (lock) => {
      if (locks.get(lock.threadId)?.token === lock.token) locks.delete(lock.threadId)
    },
    forceReleaseLock: async (threadId) => void locks.delete(threadId),
    get: async <T>(key: string) => (live(key)?.value as T | undefined) ?? null,
    set: async (key, value, ttlMs) => void values.set(key, { value, expiresAt: expiry(ttlMs) }),
    setIfNotExists: async (key, value, ttlMs) => {
      if (live(key)) return false
      values.set(key, { value, expiresAt: expiry(ttlMs) })
      return true
    },
    delete: async (key) => void values.delete(key),
    appendToList: async (key, value, options) => {
      const list = lists.get(key) ?? []
      list.push(value)
      if (options?.maxLength && list.length > options.maxLength) list.splice(0, list.length - options.maxLength)
      lists.set(key, list)
    },
    getList: async <T>(key: string) => (lists.get(key) ?? []) as T[],
    enqueue: async (threadId, entry, maxSize) => {
      const queue = queues.get(threadId) ?? []
      queue.push(entry)
      if (queue.length > maxSize) queue.splice(0, queue.length - maxSize)
      queues.set(threadId, queue)
      return queue.length
    },
    dequeue: async (threadId) => queues.get(threadId)?.shift() ?? null,
    queueDepth: async (threadId) => queues.get(threadId)?.length ?? 0,
  }
}
