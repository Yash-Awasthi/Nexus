// SPDX-License-Identifier: Apache-2.0
/**
 * The per-key lock that makes get → compute → set safe inside one process. Its one
 * dangerous property is that it must *serialise*, not just await: two concurrent callers
 * on the same key, interleaved on purpose, have to see each other's writes.
 */
import { describe, expect, it } from "vite-plus/test";

import { withKeyLock } from "../../src/lib/with-key-lock.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("withKeyLock", () => {
  it("serialises read-modify-write on one key, so the second caller sees the first's write", async () => {
    const store = new Map<string, number>([["k", 0]]);
    const bump = () =>
      withKeyLock("k", async () => {
        const base = store.get("k") ?? 0;
        await tick(); // the window that a lost update lives in
        store.set("k", base + 1);
      });
    await Promise.all([bump(), bump(), bump()]);
    expect(store.get("k")).toBe(3);
  });

  it("does not serialise different keys", async () => {
    const order: string[] = [];
    await Promise.all([
      withKeyLock("a", async () => {
        await tick();
        order.push("a");
      }),
      withKeyLock("b", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["b", "a"]);
  });

  it("keeps running after a body throws, and passes the error to its caller", async () => {
    await expect(
      withKeyLock("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withKeyLock("k", async () => "after")).resolves.toBe("after");
  });

  it("returns the body's value and forgets the key once the queue drains", async () => {
    expect(await withKeyLock("k", async () => 42)).toBe(42);
    // A stale tail would make the next body wait on a promise nobody resolves.
    await expect(withKeyLock("k", async () => "fresh")).resolves.toBe("fresh");
  });
});
