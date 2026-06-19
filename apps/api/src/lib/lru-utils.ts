// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal LRU helpers for in-memory Map-based caches.
 * JavaScript Maps preserve insertion order, so the first key is always oldest.
 */

/**
 * Evict the oldest entry from a Map when it reaches `cap`.
 * Call before inserting a new entry.
 */
export function evictOldestEntry<K, V>(map: Map<K, V>, cap: number): void {
  if (map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}
