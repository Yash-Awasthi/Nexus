// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { getSharedKV } from "../../src/lib/shared-kv.js";
import {
  appendMessages,
  createThread,
  deleteThread,
  getThread,
  listMessages,
  listThreads,
  updateThread,
} from "../../src/lib/threads-store.js";

// No REDIS_URL / UPSTASH env in tests → getSharedKV() falls back to the
// in-process MemoryKVStore. Clear it before every test so cases are isolated.
beforeEach(async () => {
  await getSharedKV().clear();
});

describe("threads-store", () => {
  it("creates a thread with generated id and defaults", async () => {
    const t = await createThread("user-1", { title: "My question" });
    expect(t.id).toBeTruthy();
    expect(t.title).toBe("My question");
    expect(new Date(t.createdAt).getTime()).not.toBeNaN();
    expect(new Date(t.updatedAt).getTime()).not.toBeNaN();
  });

  it("accepts a client id and upserts instead of duplicating", async () => {
    const a = await createThread("user-1", { id: "abc", title: "first" });
    const b = await createThread("user-1", { id: "abc", title: "first" });
    expect(a.id).toBe("abc");
    expect(b.id).toBe("abc");
    const list = await listThreads("user-1", 50);
    expect(list).toHaveLength(1);
  });

  it("lists newest-updated first", async () => {
    const a = await createThread("user-1", { title: "older" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createThread("user-1", { title: "newer" });
    expect((await listThreads("user-1", 50)).map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("updateThread retitles, bumps updatedAt, and moves to front", async () => {
    await createThread("user-1", { id: "a", title: "untitled" });
    await new Promise((r) => setTimeout(r, 5));
    await createThread("user-1", { id: "b", title: "other" });

    const updated = await updateThread("user-1", "a", { title: "Real title", mode: "council" });
    expect(updated?.title).toBe("Real title");
    expect(updated?.mode).toBe("council");

    const list = await listThreads("user-1", 50);
    expect(list[0]?.id).toBe("a");
  });

  it("updateThread on a missing id returns undefined", async () => {
    expect(await updateThread("user-1", "nope", { title: "x" })).toBeUndefined();
  });

  it("appendMessages upserts by id — re-saving never duplicates", async () => {
    await createThread("user-1", { id: "t1", title: "thread" });
    const msg = {
      id: "m1",
      role: "opinion" as const,
      member: "Builder",
      content: "hello",
      round: 0,
      createdAt: new Date().toISOString(),
    };
    await appendMessages("user-1", "t1", [msg]);
    await appendMessages("user-1", "t1", [{ ...msg, content: "hello again" }]);

    const msgs = await listMessages("user-1", "t1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("hello again");
  });

  it("appendMessages touches the thread so it surfaces as recent", async () => {
    await createThread("user-1", { id: "t1", title: "thread" });
    await new Promise((r) => setTimeout(r, 5));
    await createThread("user-1", { id: "t2", title: "other" });
    expect((await listThreads("user-1", 50))[0]?.id).toBe("t2");

    await appendMessages("user-1", "t1", [
      {
        id: "m1",
        role: "user",
        member: null,
        content: "hi",
        round: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect((await listThreads("user-1", 50))[0]?.id).toBe("t1");
  });

  it("deleteThread removes the thread and its messages", async () => {
    await createThread("user-1", { id: "t1", title: "thread" });
    await appendMessages("user-1", "t1", [
      {
        id: "m1",
        role: "user",
        member: null,
        content: "hi",
        round: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    expect(await deleteThread("user-1", "t1")).toBe(true);
    expect(await getThread("user-1", "t1")).toBeUndefined();
    expect(await listMessages("user-1", "t1")).toHaveLength(0);
    expect(await deleteThread("user-1", "t1")).toBe(false);
  });

  it("scopes everything per user — no cross-user leakage", async () => {
    await createThread("alice", { id: "t1", title: "alice-thread" });
    await createThread("bob", { id: "t2", title: "bob-thread" });

    expect((await listThreads("alice", 50)).map((t) => t.title)).toEqual(["alice-thread"]);
    expect((await listThreads("bob", 50)).map((t) => t.title)).toEqual(["bob-thread"]);
    expect(await getThread("alice", "t2")).toBeUndefined();
    expect(await listThreads("carol", 50)).toHaveLength(0);
  });

  it("getThread returns undefined for unknown ids without throwing", async () => {
    expect(await getThread("user-1", "missing")).toBeUndefined();
    expect(await listMessages("user-1", "missing")).toHaveLength(0);
  });

  it("concurrent appendMessages batches never lose a write", async () => {
    // Two tabs finishing rounds at the same moment both read the base list,
    // then each writes its own batch — without serialization the last write
    // wins and the other batch silently disappears.
    await createThread("user-1", { id: "t1", title: "thread" });
    const mk = (id: string, content: string) => ({
      id,
      role: "opinion" as const,
      member: "Builder",
      content,
      round: 0,
      createdAt: new Date().toISOString(),
    });
    await Promise.all([
      appendMessages("user-1", "t1", [mk("a1", "first")]),
      appendMessages("user-1", "t1", [mk("b1", "second")]),
    ]);
    const msgs = await listMessages("user-1", "t1");
    expect(msgs.map((m) => m.content).sort()).toEqual(["first", "second"]);
  });

  it("concurrent create with the same client id yields a single thread", async () => {
    const [a, b] = await Promise.all([
      createThread("user-1", { id: "dup", title: "one" }),
      createThread("user-1", { id: "dup", title: "one" }),
    ]);
    expect(a.id).toBe("dup");
    expect(b.id).toBe("dup");
    expect(await listThreads("user-1", 50)).toHaveLength(1);
  });
});
