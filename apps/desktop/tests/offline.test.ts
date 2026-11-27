// SPDX-License-Identifier: Apache-2.0
/**
 * The offline queue: what it keeps, what it drops, and what it says.
 *
 * The properties worth proving are the ones that decide whether a user's typed text survives an
 * outage: order, expiry, the cap, a permanent refusal leaving the queue, and a transient failure
 * leaving it in place — not merely that a JSON file round-trips.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  MAX_AGE_MS,
  MAX_PROMPT_CHARS,
  MAX_QUEUED,
  enqueue,
  flush,
  indicator,
  loadQueue,
  prune,
  saveQueue,
  type QueuedPrompt,
} from "../src/offline";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-offline-"));

const prompt = (text: string, ageMs = 0, extra: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: `id_${text}`,
  sessionId: null,
  text,
  createdAt: new Date(Date.now() - ageMs).toISOString(),
  attempts: 0,
  ...extra,
});

describe("the queue survives a restart", () => {
  it("round-trips through the file, in order", () => {
    const dir = tmp();
    const queue = [prompt("first"), prompt("second")];
    saveQueue(dir, queue);
    expect(loadQueue(dir).map((p) => p.text)).toEqual(["first", "second"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats a corrupt or absent file as empty rather than throwing", () => {
    const dir = tmp();
    expect(loadQueue(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, "offline-queue.json"), "{not json");
    expect(loadQueue(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("prune", () => {
  it("drops what is older than the window and keeps what is inside it", () => {
    const queue = [prompt("old", MAX_AGE_MS + 60_000), prompt("fresh", 1_000)];
    expect(prune(queue).map((p) => p.text)).toEqual(["fresh"]);
  });

  it("drops an entry whose timestamp is in the future, so a wrong clock cannot pin it", () => {
    const queue = [prompt("future", -10 * 60_000)];
    expect(prune(queue)).toEqual([]);
  });

  it("drops entries that are not prompts at all", () => {
    const queue = [
      prompt("real"),
      { id: 1 } as unknown as QueuedPrompt,
      null as unknown as QueuedPrompt,
    ];
    expect(prune(queue).map((p) => p.text)).toEqual(["real"]);
  });
});

describe("enqueue", () => {
  it("appends, and reports the prompt that gave way when the queue is full", () => {
    let queue: QueuedPrompt[] = [];
    for (let i = 0; i < MAX_QUEUED; i += 1) queue = enqueue(queue, { text: `p${i}` }).queue;
    const result = enqueue(queue, { text: "newest" });
    expect(result.queue.length).toBe(MAX_QUEUED);
    expect(result.dropped?.text).toBe("p0");
    expect(result.queue.at(-1)?.text).toBe("newest");
  });

  it("refuses an empty prompt and one past the size limit", () => {
    expect(() => enqueue([], { text: "   " })).toThrow(/empty/);
    expect(() => enqueue([], { text: "x".repeat(MAX_PROMPT_CHARS + 1) })).toThrow(/over the/);
  });

  it("trims, and gives the entry an id and a timestamp", () => {
    const { queue } = enqueue([], { text: "  hello  ", sessionId: "s1", now: 1_700_000_000_000 });
    expect(queue[0]).toMatchObject({ text: "hello", sessionId: "s1", attempts: 0 });
    expect(queue[0].createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(queue[0].id.length).toBeGreaterThan(4);
  });
});

describe("flush", () => {
  it("sends in order and empties the queue", async () => {
    const sent: string[] = [];
    const result = await flush([prompt("a"), prompt("b")], async (p) => {
      sent.push(p.text);
      return { ok: true };
    });
    expect(sent).toEqual(["a", "b"]);
    expect(result.sent.map((p) => p.text)).toEqual(["a", "b"]);
    expect(result.queue).toEqual([]);
  });

  it("keeps a transiently refused prompt, counts the attempt, and stops the walk", async () => {
    const result = await flush([prompt("a"), prompt("b")], async () => ({
      ok: false,
      error: "connect ECONNREFUSED",
    }));
    expect(result.queue.map((p) => p.text)).toEqual(["a", "b"]);
    expect(result.queue[0]).toMatchObject({ attempts: 1, lastError: "connect ECONNREFUSED" });
    // The second keeps its zero attempts: its turn never came.
    expect(result.queue[1].attempts).toBe(0);
  });

  it("drops a permanent refusal and carries on with the next prompt", async () => {
    const result = await flush([prompt("bad"), prompt("good")], async (p) =>
      p.text === "bad"
        ? { ok: false, permanent: true, error: "400: the session was deleted" }
        : { ok: true },
    );
    expect(result.dropped).toEqual([
      { prompt: expect.objectContaining({ text: "bad" }), reason: "400: the session was deleted" },
    ]);
    expect(result.sent.map((p) => p.text)).toEqual(["good"]);
    expect(result.queue).toEqual([]);
  });

  it("treats a thrown send as transient, not as a reason to drop the prompt", async () => {
    const result = await flush([prompt("a")], async () => {
      throw new Error("fetch failed");
    });
    expect(result.queue[0]).toMatchObject({ attempts: 1, lastError: "fetch failed" });
  });
});

describe("indicator", () => {
  it("names the count, because 'offline' alone hides whether the work is still there", () => {
    expect(indicator({ online: false, queued: 0 })).toEqual({ label: "Offline", tone: "warn" });
    expect(indicator({ online: false, queued: 2 }).label).toBe("Offline — 2 prompts queued");
    expect(indicator({ online: false, queued: 1 }).label).toBe("Offline — 1 prompt queued");
  });

  it("distinguishes sending from waiting, and online-with-nothing from online", () => {
    expect(indicator({ online: true, queued: 0 })).toEqual({ label: "Online", tone: "ok" });
    expect(indicator({ online: true, queued: 0, flushing: true })).toEqual({
      label: "Online",
      tone: "ok",
    });
    expect(indicator({ online: true, queued: 3 }).label).toBe(
      "3 prompts queued — sending on reconnect",
    );
    expect(indicator({ online: true, queued: 3, flushing: true }).label).toBe(
      "Sending 3 queued prompts…",
    );
  });

  it("never prints a negative or fractional count", () => {
    expect(indicator({ online: false, queued: -4 }).label).toBe("Offline");
    expect(indicator({ online: false, queued: 1.7 }).label).toBe("Offline — 1 prompt queued");
  });
});
