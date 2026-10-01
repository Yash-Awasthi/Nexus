// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";

import { MemoryStore } from "../src/memory-store.js";
import type { MemoryEntry } from "../src/memory-store.js";

function makeEntry(
  overrides: Partial<Omit<MemoryEntry, "id" | "timestamp">> = {},
): Omit<MemoryEntry, "id" | "timestamp"> {
  return {
    type: "observation",
    key: "test-key",
    value: { data: "test" },
    tags: ["unit-test"],
    agentId: "agent-1",
    workflowId: "wf-1",
    ...overrides,
  };
}

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  describe("store()", () => {
    it("stores an entry and returns a non-empty id", async () => {
      const id = await store.store(makeEntry());
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("each store() returns a unique id", async () => {
      const id1 = await store.store(makeEntry({ key: "key-a" }));
      const id2 = await store.store(makeEntry({ key: "key-b" }));
      expect(id1).not.toBe(id2);
    });
  });

  describe("get()", () => {
    it("retrieves a stored entry by id", async () => {
      const id = await store.store(makeEntry({ key: "retrieve-me", value: 42 }));
      const entry = await store.get(id);
      expect(entry).toBeDefined();
      expect(entry?.key).toBe("retrieve-me");
      expect(entry?.value).toBe(42);
    });

    it("returns undefined for unknown id", async () => {
      const entry = await store.get("unknown-id-xyz");
      expect(entry).toBeUndefined();
    });

    it("entry has a timestamp set on store", async () => {
      const before = new Date();
      const id = await store.store(makeEntry());
      const after = new Date();
      const entry = await store.get(id);
      expect(entry?.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(entry?.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe("delete()", () => {
    it("removes an entry", async () => {
      const id = await store.store(makeEntry());
      await store.delete(id);
      const entry = await store.get(id);
      expect(entry).toBeUndefined();
    });

    it("is idempotent — deleting non-existent id does not throw", async () => {
      await expect(store.delete("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("query()", () => {
    beforeEach(async () => {
      await store.store(makeEntry({ type: "observation", agentId: "agent-A", tags: ["x"] }));
      await store.store(makeEntry({ type: "decision", agentId: "agent-A", tags: ["y"] }));
      await store.store(makeEntry({ type: "result", agentId: "agent-B", tags: ["x", "z"] }));
      await store.store(makeEntry({ type: "error", agentId: "agent-B", tags: ["z"] }));
    });

    it("returns all entries with empty query", async () => {
      const result = await store.query({});
      expect(result.entries.length).toBeGreaterThanOrEqual(4);
      expect(result.total).toBeGreaterThanOrEqual(4);
    });

    it("filters by type", async () => {
      const result = await store.query({ types: ["decision"] });
      expect(result.entries.every((e) => e.type === "decision")).toBe(true);
    });

    it("filters by multiple types", async () => {
      const result = await store.query({ types: ["observation", "error"] });
      expect(result.entries.every((e) => e.type === "observation" || e.type === "error")).toBe(
        true,
      );
    });

    it("filters by agent", async () => {
      const result = await store.query({ agents: ["agent-A"] });
      expect(result.entries.every((e) => e.agentId === "agent-A")).toBe(true);
      expect(result.entries.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by tag", async () => {
      const result = await store.query({ tags: ["z"] });
      expect(result.entries.every((e) => e.tags.includes("z"))).toBe(true);
    });

    it("respects limit", async () => {
      const result = await store.query({ limit: 2 });
      expect(result.entries.length).toBeLessThanOrEqual(2);
    });

    it("query reflects total count regardless of limit", async () => {
      const full = await store.query({});
      const limited = await store.query({ limit: 1 });
      expect(limited.total).toBe(full.total);
    });
  });

  describe("prune()", () => {
    it("removes expired entries (ttlMs elapsed)", async () => {
      await store.store(makeEntry({ ttlMs: 1 })); // expires in 1ms
      await new Promise((r) => setTimeout(r, 10));
      const pruned = await store.prune();
      expect(pruned).toBeGreaterThanOrEqual(1);
    });

    it("does not remove non-expired entries", async () => {
      await store.store(makeEntry({ ttlMs: 60_000 })); // 1 minute
      const pruned = await store.prune();
      expect(pruned).toBe(0);
    });

    it("entries without ttlMs are never pruned", async () => {
      await store.store(makeEntry()); // no ttlMs
      await new Promise((r) => setTimeout(r, 10));
      const pruned = await store.prune();
      expect(pruned).toBe(0);
    });
  });

  describe("getStats()", () => {
    it("returns 0 totalEntries on empty store", async () => {
      const stats = await store.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.oldest).toBeNull();
      expect(stats.newest).toBeNull();
    });

    it("counts total entries correctly", async () => {
      await store.store(makeEntry({ type: "observation" }));
      await store.store(makeEntry({ type: "decision" }));
      const stats = await store.getStats();
      expect(stats.totalEntries).toBe(2);
    });

    it("groups by type", async () => {
      await store.store(makeEntry({ type: "observation" }));
      await store.store(makeEntry({ type: "observation" }));
      await store.store(makeEntry({ type: "error" }));
      const stats = await store.getStats();
      expect(stats.byType["observation"]).toBe(2);
      expect(stats.byType["error"]).toBe(1);
    });

    it("sets oldest and newest timestamps", async () => {
      await store.store(makeEntry());
      await new Promise((r) => setTimeout(r, 5));
      await store.store(makeEntry());
      const stats = await store.getStats();
      expect(stats.oldest).toBeInstanceOf(Date);
      expect(stats.newest).toBeInstanceOf(Date);
      expect(stats.newest!.getTime()).toBeGreaterThanOrEqual(stats.oldest!.getTime());
    });
  });
});
