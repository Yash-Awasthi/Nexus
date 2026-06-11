import { MemoryStore, TraceIndexer } from "../orchestration/memory-store";

// ─── Mock Persistence ────────────────────────────────────────────────

class MockPersistence {
  private data: Record<string, any> = {};
  async saveState(key: string, state: any): Promise<void> {
    this.data[key] = state;
  }
  async getState<T>(key: string): Promise<T | undefined> {
    return this.data[key] as T;
  }
}

describe("MemoryStore", () => {
  let store: MemoryStore;
  let persistence: MockPersistence;

  beforeEach(() => {
    persistence = new MockPersistence();
    store = new MemoryStore(persistence as any);
  });

  afterEach(async () => {
    // Clear entries
    const stats = await store.getStats();
    for (const key of Object.keys(stats.byType)) {
      const entries = await store.query({ types: [key as any], limit: 1000 });
      for (const e of entries.entries) {
        await store.delete(e.id);
      }
    }
  });

  test("store and retrieve an entry", async () => {
    const id = await store.store({
      type: "observation",
      key: "test:hello",
      value: { message: "Hello, world!" },
      tags: ["test"],
      agentId: "test-agent"
    });
    expect(id).toBeTruthy();
    expect(id.startsWith("mem-")).toBe(true);

    const entry = await store.get(id);
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("test:hello");
    expect(entry!.value).toEqual({ message: "Hello, world!" });
    expect(entry!.agentId).toBe("test-agent");
    expect(entry!.type).toBe("observation");
    expect(Array.isArray(entry!.tags)).toBe(true);
  });

  test("store multiple entry types", async () => {
    const types = ["observation", "decision", "result", "error", "state", "knowledge"] as const;
    const ids: string[] = [];
    for (const type of types) {
      const id = await store.store({
        type,
        key: `type:${type}`,
        value: { type },
        tags: ["test", type]
      });
      ids.push(id);
    }

    const stats = await store.getStats();
    expect(stats.totalEntries).toBe(6);
    for (const type of types) {
      expect(stats.byType[type]).toBe(1);
    }
  });

  test("query by type", async () => {
    await store.store({ type: "observation", key: "obs1", value: "a", tags: [] });
    await store.store({ type: "observation", key: "obs2", value: "b", tags: [] });
    await store.store({ type: "decision", key: "dec1", value: "c", tags: [] });

    const observations = await store.query({ types: ["observation"] });
    expect(observations.total).toBe(2);
    expect(observations.entries).toHaveLength(2);
    expect(observations.entries.every((e) => e.type === "observation")).toBe(true);

    const decisions = await store.query({ types: ["decision"] });
    expect(decisions.total).toBe(1);
  });

  test("query by tags", async () => {
    await store.store({ type: "knowledge", key: "k1", value: "v1", tags: ["alpha", "beta"] });
    await store.store({ type: "knowledge", key: "k2", value: "v2", tags: ["alpha"] });
    await store.store({ type: "knowledge", key: "k3", value: "v3", tags: ["beta"] });

    const alphaOnly = await store.query({ tags: ["alpha"] });
    expect(alphaOnly.total).toBe(2);

    const betaOnly = await store.query({ tags: ["beta"] });
    expect(betaOnly.total).toBe(2);

    const alphaAndBeta = await store.query({ tags: ["alpha", "beta"] });
    // With AND semantics for tags, both tags must match
    expect(alphaAndBeta.total).toBeGreaterThan(0);
  });

  test("query by key prefix", async () => {
    await store.store({ type: "state", key: "user:123:name", value: "Alice", tags: [] });
    await store.store({ type: "state", key: "user:123:email", value: "alice@test.com", tags: [] });
    await store.store({ type: "state", key: "config:theme", value: "dark", tags: [] });

    const userEntries = await store.query({ keyPrefix: "user:" });
    expect(userEntries.total).toBe(2);

    const configEntries = await store.query({ keyPrefix: "config:" });
    expect(configEntries.total).toBe(1);
  });

  test("query with limit and offset", async () => {
    for (let i = 0; i < 10; i++) {
      await store.store({ type: "observation", key: `entry:${i}`, value: i, tags: [] });
    }

    const first5 = await store.query({ types: ["observation"], limit: 5 });
    expect(first5.entries).toHaveLength(5);
    expect(first5.total).toBe(10);

    const offset5 = await store.query({ types: ["observation"], limit: 5, offset: 5 });
    expect(offset5.entries).toHaveLength(5);
    // Ensure no overlap between pages
    const firstIds = new Set(first5.entries.map((e) => e.id));
    const offsetIds = new Set(offset5.entries.map((e) => e.id));
    for (const id of offsetIds) {
      expect(firstIds.has(id)).toBe(false);
    }
  });

  test("delete an entry", async () => {
    const id = await store.store({
      type: "knowledge",
      key: "temp:data",
      value: "delete me",
      tags: ["temp"]
    });

    expect(await store.get(id)).toBeDefined();

    await store.delete(id);
    expect(await store.get(id)).toBeUndefined();

    const stats = await store.getStats();
    expect(stats.totalEntries).toBe(0);
  });

  test("TTL expiration", async () => {
    const id = await store.store({
      type: "observation",
      key: "temp:ttl",
      value: "expires fast",
      tags: [],
      ttlMs: 1 // 1ms TTL
    });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    const entry = await store.get(id);
    expect(entry).toBeUndefined();
  });

  test("prune expired entries", async () => {
    await store.store({ type: "observation", key: "keep", value: "keep", tags: [], ttlMs: 60000 });
    await store.store({ type: "state", key: "remove", value: "remove", tags: [], ttlMs: 1 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const pruned = await store.prune();
    expect(pruned).toBe(1);

    const stats = await store.getStats();
    expect(stats.totalEntries).toBe(1);
  });

  test("getStats returns correct counts", async () => {
    await store.store({ type: "observation", key: "o1", value: 1, tags: [] });
    await store.store({ type: "observation", key: "o2", value: 2, tags: [] });
    await store.store({ type: "decision", key: "d1", value: 3, tags: [] });
    await store.store({ type: "result", key: "r1", value: 4, tags: [] });

    const stats = await store.getStats();
    expect(stats.totalEntries).toBe(4);
    expect(stats.byType["observation"]).toBe(2);
    expect(stats.byType["decision"]).toBe(1);
    expect(stats.byType["result"]).toBe(1);
    expect(stats.oldest).toBeInstanceOf(Date);
    expect(stats.newest).toBeInstanceOf(Date);
  });

  test("startAutoPrune and stopAutoPrune manage the timer lifecycle", async () => {
    // startAutoPrune should not throw
    store.startAutoPrune(60000);

    // Calling start again (re-entrant) should not throw
    store.startAutoPrune(30000);

    // stopAutoPrune should clear the timer
    store.stopAutoPrune();

    // Calling stop again is a no-op
    store.stopAutoPrune();

    // After stop, the store still works normally
    const id = await store.store({ type: "observation", key: "post:auto:prune", value: "works", tags: [] });
    expect(await store.get(id)).toBeDefined();

    store.stopAutoPrune();
  });

  test("auto-prune with startAutoPrune evicts expired entries", async () => {
    // Store an entry that expires quickly
    await store.store({ type: "state", key: "auto:expire", value: "gone", tags: [], ttlMs: 20 });
    // Store an entry that persists
    await store.store({ type: "state", key: "auto:keep", value: "stay", tags: [], ttlMs: 60000 });

    expect((await store.getStats()).totalEntries).toBe(2);

    // Start auto-prune with aggressive interval
    store.startAutoPrune(10);

    // Wait for TTL + sweep
    await new Promise((r) => setTimeout(r, 60));

    store.stopAutoPrune();

    const stats = await store.getStats();
    // The expired entry should have been pruned by the auto-sweeper
    expect(stats.totalEntries).toBeLessThanOrEqual(1);
  }, 10000);

  test("concurrent store + auto-prune race safety", async () => {
    // Store entries with very short TTLs
    for (let i = 0; i < 50; i++) {
      await store.store({
        type: "observation",
        key: `race:${i}`,
        value: { index: i },
        tags: ["race"],
        ttlMs: Math.random() * 20 + 5 // 5-25ms TTL
      });
    }
    // Store entries without TTL (should survive)
    const persistentIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await store.store({
        type: "knowledge",
        key: `persistent:${i}`,
        value: { data: i },
        tags: ["persistent"]
      });
      persistentIds.push(id);
    }

    // Start aggressive auto-prune while concurrently storing more entries
    store.startAutoPrune(10);

    const storePromises: Promise<string>[] = [];
    for (let i = 0; i < 100; i++) {
      storePromises.push(
        store.store({
          type: "state",
          key: `concurrent:${i}`,
          value: { index: i },
          tags: ["concurrent"],
          ttlMs: Math.random() < 0.3 ? 10 : undefined // 30% have short TTL
        })
      );
    }

    // Concurrently try to get entries while auto-prune sweeps
    const getPromises = persistentIds.map((id) => store.get(id));

    // Run everything in parallel
    const newIds = await Promise.all(storePromises);
    const gets = await Promise.all(getPromises);

    store.stopAutoPrune();

    // All persistent (no TTL) entries should still be retrievable
    for (const entry of gets) {
      expect(entry).toBeDefined();
      expect(entry!.tags).toContain("persistent");
    }

    // All new store operations should have succeeded (returned IDs)
    expect(newIds.length).toBe(100);
    expect(newIds.every((id) => id.startsWith("mem-"))).toBe(true);

    // Stats should reflect remaining non-TTL + surviving entries
    const stats = await store.getStats();
    expect(stats.totalEntries).toBeGreaterThanOrEqual(20); // at least persistent entries survive

    // Query for persistent entries — all 20 should survive
    const queryResult = await store.query({ tags: ["persistent"] });
    expect(queryResult.total).toBe(20);
  });

  test("persistence roundtrip", async () => {
    const id = await store.store({
      type: "knowledge",
      key: "persist:test",
      value: { data: "hello" },
      tags: ["persist"]
    });

    // Create a new MemoryStore with the same persistence to verify data survives
    const store2 = new MemoryStore(persistence as any);
    const entry = await store2.get(id);
    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ data: "hello" });
  });
});

describe("TraceIndexer", () => {
  test("maps event names to memory types correctly", () => {
    const mockStore = {
      store: jest.fn().mockResolvedValue("mem-id")
    } as any;

    const mockEventStore = {
      replayEvents: jest.fn().mockResolvedValue([
        { event: "task_completed", payload: { workflowId: "wf-1" } },
        { event: "execution_failed", payload: { taskId: "t-1" } },
        { event: "plan_approved", payload: { workflowId: "wf-1" } },
        { event: "task_routed", payload: { workflowId: "wf-2" } },
        { event: "state_snapshot", payload: { workflowId: "wf-3" } },
        { event: "unknown_event", payload: {} }
      ])
    } as any;

    const indexer = new TraceIndexer(mockEventStore, mockStore);
    return indexer.indexRecentEvents().then((count) => {
      expect(count).toBe(5); // 5 out of 6 events mapped (unknown_event skipped)
      expect(mockStore.store).toHaveBeenCalledTimes(5);
      expect(mockStore.store).toHaveBeenCalledWith(
        expect.objectContaining({ type: "result", key: "event:task_completed" })
      );
    });
  });

  test("skips already indexed events", async () => {
    const mockStore = {
      store: jest.fn().mockResolvedValue("mem-id")
    } as any;

    const mockEventStore = {
      replayEvents: jest.fn().mockResolvedValue([
        { event: "task_succeeded", payload: {} }
      ])
    } as any;

    const indexer = new TraceIndexer(mockEventStore, mockStore);

    // First call indexes 1 event
    await indexer.indexRecentEvents();
    expect(mockStore.store).toHaveBeenCalledTimes(1);

    // Second call with no new events
    const count2 = await indexer.indexRecentEvents();
    expect(count2).toBe(0);
    expect(mockStore.store).toHaveBeenCalledTimes(1); // No new calls
  });
});
