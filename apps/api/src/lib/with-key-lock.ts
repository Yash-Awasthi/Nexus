// SPDX-License-Identifier: Apache-2.0
/**
 * Per-key promise-chain lock for KV read-modify-write mutations.
 *
 * Every KV store mutation here is get → compute → set; two calls in flight for
 * the same key (e.g. two tabs finishing at the same moment) would both read the
 * same base and the last write would silently drop the other batch. This
 * serializes mutations per key within one process/pod. Cross-pod atomicity
 * would need a Lua script on the Redis side (out of scope — single-writer-per-
 * pod reality).
 *
 * Re-entrancy: callers must NOT call another locked public mutator from inside
 * a locked body (that deadlocks). Expose an unlocked internal for composition.
 */

const _keyLocks = new Map<string, Promise<void>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = prev.catch(() => {}).then(() => new Promise<void>((r) => (release = r)));
  _keyLocks.set(key, tail);
  return prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      release();
      if (_keyLocks.get(key) === tail) _keyLocks.delete(key);
    });
}
