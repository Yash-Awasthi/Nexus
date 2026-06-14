// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryKVStore,
  InMemoryObsStore,
  serialize,
  deserialize,
  type Observation,
} from "../src/index.js";

// ── InMemoryKVStore ───────────────────────────────────────────────────────────

describe("InMemoryKVStore", () => {
  let kv: InMemoryKVStore;
  beforeEach(() => { kv = new InMemoryKVStore(); });

  it("set and get", async () => {
    await kv.set("foo", "bar");
    expect(await kv.get("foo")).toBe("bar");
  });

  it("get returns undefined for missing key", async () => {
    expect(await kv.get("missing")).toBeUndefined();
  });

  it("delete removes key", async () => {
    await kv.set("k", "v");
    const removed = await kv.delete("k");
    expect(removed).toBe(true);
    expect(await kv.get("k")).toBeUndefined();
  });

  it("delete returns false for missing key", async () => {
    expect(await kv.delete("ghost")).toBe(false);
  });

  it("list returns all entries sorted by key", async () => {
    await kv.set("b", "2"); await kv.set("a", "1"); await kv.set("c", "3");
    const list = await kv.list();
    expect(list.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  it("list with prefix filters correctly", async () => {
    await kv.set("ns:a", "1"); await kv.set("ns:b", "2"); await kv.set("other:c", "3");
    const list = await kv.list("ns:");
    expect(list).toHaveLength(2);
    expect(list.every((e) => e.key.startsWith("ns:"))).toBe(true);
  });

  it("clear removes all entries", async () => {
    await kv.set("a", "1"); await kv.set("b", "2");
    await kv.clear();
    expect(await kv.size()).toBe(0);
  });

  it("size returns correct count", async () => {
    await kv.set("a", "1"); await kv.set("b", "2");
    expect(await kv.size()).toBe(2);
  });

  it("TTL: expired entry is not returned", async () => {
    await kv.set("temp", "val", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await kv.get("temp")).toBeUndefined();
  });

  it("TTL: entry within TTL is returned", async () => {
    await kv.set("temp", "val", 100_000);
    expect(await kv.get("temp")).toBe("val");
  });

  it("overwrite updates value", async () => {
    await kv.set("k", "old");
    await kv.set("k", "new");
    expect(await kv.get("k")).toBe("new");
  });
});

// ── InMemoryObsStore ──────────────────────────────────────────────────────────

describe("InMemoryObsStore", () => {
  let store: InMemoryObsStore;

  function obs(id: string, sessionId: string, type: string, content: string): Observation {
    return { id, sessionId, type, content, createdAt: Date.now() };
  }

  beforeEach(() => { store = new InMemoryObsStore(); });

  it("add and getBySession", async () => {
    await store.add(obs("1", "s1", "note", "hello"));
    await store.add(obs("2", "s2", "note", "world"));
    const s1obs = await store.getBySession("s1");
    expect(s1obs).toHaveLength(1);
    expect(s1obs[0]!.id).toBe("1");
  });

  it("getBySession returns empty for unknown session", async () => {
    expect(await store.getBySession("ghost")).toEqual([]);
  });

  it("getByType filters by type", async () => {
    await store.add(obs("1", "s", "note", "n"));
    await store.add(obs("2", "s", "signal", "s"));
    await store.add(obs("3", "s", "note", "n2"));
    const notes = await store.getByType("note");
    expect(notes).toHaveLength(2);
    expect(notes.every((o) => o.type === "note")).toBe(true);
  });

  it("getByType respects limit", async () => {
    for (let i = 0; i < 5; i++) await store.add(obs(`${i}`, "s", "note", `n${i}`));
    expect(await store.getByType("note", 3)).toHaveLength(3);
  });

  it("delete removes observation", async () => {
    await store.add(obs("1", "s", "note", "n"));
    const removed = await store.delete("1");
    expect(removed).toBe(true);
    expect(await store.count()).toBe(0);
  });

  it("delete returns false for unknown id", async () => {
    expect(await store.delete("ghost")).toBe(false);
  });

  it("clear empties store", async () => {
    await store.add(obs("1", "s", "note", "n"));
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it("count reflects current size", async () => {
    await store.add(obs("1", "s", "note", "n"));
    await store.add(obs("2", "s", "note", "n"));
    expect(await store.count()).toBe(2);
  });
});

// ── serialize / deserialize ───────────────────────────────────────────────────

describe("serialize / deserialize", () => {
  it("roundtrip object", () => {
    const obj = { a: 1, b: [1, 2, 3], c: "hello" };
    expect(deserialize(serialize(obj))).toEqual(obj);
  });

  it("roundtrip number", () => {
    expect(deserialize<number>(serialize(42))).toBe(42);
  });

  it("deserialize undefined returns undefined", () => {
    expect(deserialize(undefined)).toBeUndefined();
  });

  it("deserialize invalid JSON returns undefined", () => {
    expect(deserialize("{bad json")).toBeUndefined();
  });
});
