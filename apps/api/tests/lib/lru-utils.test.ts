// SPDX-License-Identifier: Apache-2.0
/**
 * The LRU helper every Map-backed cache calls before inserting. Small enough to look
 * obviously right, which is exactly why the two ways it can be wrong — not evicting at
 * the cap, and evicting the *newest* key because a re-set kept its position — are worth
 * pinning.
 */
import { describe, expect, it } from "vite-plus/test";

import { evictOldestEntry } from "../../src/lib/lru-utils.ts";

describe("evictOldestEntry", () => {
  it("evicts the first-inserted key, not the most recent", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    evictOldestEntry(map, 2);
    expect([...map.keys()]).toEqual(["b"]);
  });

  it("does nothing below the cap, so a cache can fill up", () => {
    const map = new Map([["a", 1]]);
    evictOldestEntry(map, 3);
    expect(map.size).toBe(1);
  });

  it("evicts exactly one entry per call, so a burst over the cap shrinks rather than empties", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    evictOldestEntry(map, 3);
    expect([...map.keys()]).toEqual(["b", "c"]);
  });
});
