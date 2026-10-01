// SPDX-License-Identifier: Apache-2.0
/**
 * A per-account cache that lets go of accounts gone quiet. Only for what can be rebuilt on the
 * next request: an evicted entry is gone, so anything an account chose must live in a store.
 */
export class IdleMap<K, V> {
  private entries = new Map<K, { value: V; at: number }>();
  private lastSweep = 0;

  constructor(
    private readonly idleMs: number,
    private readonly onEvict?: (value: V) => void,
  ) {}

  get(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.idleMs) {
      this.evict(key, e.value);
      return undefined;
    }
    e.at = Date.now();
    return e.value;
  }

  set(key: K, value: V): void {
    const cutoff = Date.now() - this.idleMs;
    if (this.lastSweep < cutoff) {
      this.lastSweep = Date.now();
      for (const [k, e] of this.entries) if (e.at < cutoff) this.evict(k, e.value);
    }
    this.entries.set(key, { value, at: Date.now() });
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(key: K, value: V): void {
    this.entries.delete(key);
    this.onEvict?.(value);
  }
}
