// SPDX-License-Identifier: Apache-2.0
/**
 * Threads HTTP surface — exercises /api/threads* through the real server
 * (buildServer + inject): auth gating, empty/junk input, ordering, and the
 * full create → list → patch → messages → delete lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";

const AUTH = { authorization: "Bearer test" };

describe("threads API surface", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await getSharedKV().clear();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it("requires auth on every route when a key is configured", async () => {
    // Auth is read at request time: with NEXUS_API_KEY set, every route must
    // reject an anonymous caller with 401 before touching state.
    process.env.NEXUS_API_KEY = "threads-test-key";
    try {
      for (const req of [
        { method: "GET", url: "/api/threads" },
        { method: "POST", url: "/api/threads", payload: {} },
        { method: "GET", url: "/api/threads/x/messages" },
        { method: "PATCH", url: "/api/threads/x", payload: {} },
        { method: "DELETE", url: "/api/threads/x" },
      ]) {
        const res = await app.inject(req as never);
        expect(res.statusCode).toBe(401); // `${req.method} ${req.url}` must 401
      }
    } finally {
      delete process.env.NEXUS_API_KEY;
    }
  });

  it("dev bypass: routes are open when no auth is configured", async () => {
    // With neither NEXUS_API_KEY nor a JWT secret set, auth.ts enables its
    // documented dev bypass — the preHandler still runs on every route, but
    // anonymous traffic passes. Asserting this pins the current contract.
    const res = await app.inject({ method: "GET", url: "/api/threads" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().threads)).toBe(true);
  });

  it("full lifecycle: create → list → patch → messages → delete", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { id: "t1", title: "New deliberation" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().id).toBe("t1");

    const list = await app.inject({ method: "GET", url: "/api/threads", headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.json().threads.map((t: { id: string }) => t.id)).toEqual(["t1"]);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/threads/t1",
      headers: AUTH,
      payload: { title: "Real title", mode: "council" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().title).toBe("Real title");

    const msgPost = await app.inject({
      method: "POST",
      url: "/api/threads/t1/messages",
      headers: AUTH,
      payload: {
        messages: [
          { id: "m1", role: "user", member: null, content: "hi", round: 0 },
          { id: "m2", role: "opinion", member: "Builder", content: "answer", round: 0 },
        ],
      },
    });
    expect(msgPost.json().stored).toBe(2);

    const msgs = await app.inject({
      method: "GET",
      url: "/api/threads/t1/messages",
      headers: AUTH,
    });
    expect(msgs.json().messages).toHaveLength(2);
    expect(msgs.json().messages[1].role).toBe("opinion");

    const del = await app.inject({ method: "DELETE", url: "/api/threads/t1", headers: AUTH });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/threads/t1", headers: AUTH })).statusCode,
    ).toBe(404);
    // Messages are gone with the thread.
    expect(
      (await app.inject({ method: "GET", url: "/api/threads/t1/messages", headers: AUTH }))
        .statusCode,
    ).toBe(404);
  });

  it("keeps the archetype an opinion was given under", async () => {
    await app.inject({ method: "POST", url: "/api/threads", headers: AUTH, payload: { id: "ta" } });
    await app.inject({
      method: "POST",
      url: "/api/threads/ta/messages",
      headers: AUTH,
      payload: {
        messages: [
          {
            id: "o1",
            role: "opinion",
            member: "Groq",
            archetype: "The Contrarian",
            content: "no",
            round: 1,
          },
          { id: "o2", role: "opinion", member: "Gemini", content: "yes", round: 1 },
        ],
      },
    });
    const msgs = (
      await app.inject({ method: "GET", url: "/api/threads/ta/messages", headers: AUTH })
    ).json<{ messages: { id: string; archetype?: string | null }[] }>().messages;
    expect(msgs.find((m) => m.id === "o1")?.archetype).toBe("The Contrarian");
    expect(msgs.find((m) => m.id === "o2")?.archetype ?? null).toBeNull();
  });

  it("newest-updated first after a patch reorders", async () => {
    await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { id: "older", title: "older" },
    });
    await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { id: "newer", title: "newer" },
    });
    let list = await app.inject({ method: "GET", url: "/api/threads", headers: AUTH });
    expect(list.json().threads.map((t: { id: string }) => t.id)).toEqual(["newer", "older"]);

    // Touching the older thread (message append) moves it back to the front.
    await app.inject({
      method: "POST",
      url: "/api/threads/older/messages",
      headers: AUTH,
      payload: { messages: [{ id: "m", role: "user", member: null, content: "x", round: 0 }] },
    });
    list = await app.inject({ method: "GET", url: "/api/threads", headers: AUTH });
    expect(list.json().threads.map((t: { id: string }) => t.id)).toEqual(["older", "newer"]);
  });

  it("sanitizes empty and junk input without 500s", async () => {
    // Empty body → generated id + default title.
    const empty = await app.inject({ method: "POST", url: "/api/threads", headers: AUTH });
    expect(empty.statusCode).toBe(201);
    const t = empty.json();
    expect(t.id).toBeTruthy();
    expect(t.title).toBe("New deliberation");

    // Unknown role → opinion; empty content dropped; junk entries skipped.
    const junk = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/messages`,
      headers: AUTH,
      payload: {
        messages: [
          { id: "x1", role: "hacker", content: "kept" },
          { id: "x2", role: "user", content: "" },
          null,
          "nope",
        ],
      },
    });
    expect(junk.json().stored).toBe(1);
    const msgs = await app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages`,
      headers: AUTH,
    });
    expect(msgs.json().messages).toHaveLength(1);
    expect(msgs.json().messages[0].role).toBe("opinion");

    // Empty batch → stored 0.
    const zero = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/messages`,
      headers: AUTH,
      payload: { messages: [] },
    });
    expect(zero.json().stored).toBe(0);

    // Messages for a missing thread → 404; patch for a missing thread → 404.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/threads/nope/messages",
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/threads/nope",
          headers: AUTH,
          payload: { title: "x" },
        })
      ).statusCode,
    ).toBe(404);

    // Non-array messages body → stored 0 (no throw).
    const notArray = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/messages`,
      headers: AUTH,
      payload: { messages: { id: "z", role: "user", content: "hi", round: 0 } },
    });
    expect(notArray.statusCode).toBe(200);
    expect(notArray.json().stored).toBe(0);
  });

  it("limit query is clamped to a sane range", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/threads",
        headers: AUTH,
        payload: { title: `t${i}` },
      });
    }
    for (const q of ["limit=2", "limit=0", "limit=abc", "limit=9999"]) {
      const res = await app.inject({ method: "GET", url: `/api/threads?${q}`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().threads.length).toBeGreaterThan(0);
      expect(res.json().threads.length).toBeLessThanOrEqual(5);
    }
  });

  it("q finds threads by title or by what was said, with a snippet for the latter", async () => {
    const make = (id: string, title: string) =>
      app.inject({ method: "POST", url: "/api/threads", headers: AUTH, payload: { id, title } });
    await make("a", "Pricing debate");
    await make("b", "Untitled");
    await make("c", "Hiring plan");
    await app.inject({
      method: "POST",
      url: "/api/threads/b/messages",
      headers: AUTH,
      payload: {
        messages: [
          {
            id: "m1",
            role: "user",
            content: "Should we move the launch to Q3 because of PRICING?",
          },
        ],
      },
    });
    const find = async (q: string) =>
      (await app.inject({ method: "GET", url: `/api/threads?q=${q}`, headers: AUTH })).json()
        .threads as { id: string; snippet?: string }[];

    const hits = await find("pricing");
    expect(hits.map((t) => t.id)).toEqual(["b", "a"]);
    expect(hits[0].snippet).toContain("PRICING");
    expect(hits[1].snippet).toBeUndefined();
    expect(await find("nothing-like-this")).toEqual([]);
    expect((await find("%20")).length).toBe(3);
  });
});
