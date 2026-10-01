// SPDX-License-Identifier: Apache-2.0
/**
 * The `/api/stm*` surface was one process-global array and two module-level
 * variables, so on a deployment with more than one account every user read and
 * wrote the same rows: one person's prompts were visible to everyone, and
 * toggling a module toggled it for the whole server.
 *
 * These drive the real routes as two different authenticated users and assert
 * the isolation directly, plus the durability the store now provides.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;

const SECRET = "stm-route-test-secret";

/** A signed token for a distinct user, matching the server's JWT settings. */
function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const ALICE = `alice-${crypto.randomUUID()}`;
const BOB = `bob-${crypto.randomUUID()}`;

async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  userId: string,
  payload?: Record<string, unknown>,
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

beforeAll(async () => {
  process.env.NEXUS_JWT_SECRET = SECRET;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("STM history is per user", () => {
  it("answers in the shape the page reads", async () => {
    await call("POST", "/api/stm/history", ALICE, { query: "shape check", modules: [] });

    const body = JSON.parse((await call("GET", "/api/stm/history", ALICE)).payload) as {
      entries?: unknown[];
    };

    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("hides one user's entries from another", async () => {
    await call("POST", "/api/stm/history", ALICE, {
      query: "alice private prompt",
      modules: ["hedge"],
      applied: ["hedge"],
    });

    const mine = (
      JSON.parse((await call("GET", "/api/stm/history", ALICE)).payload) as {
        entries: { query: string }[];
      }
    ).entries;
    const theirs = (await call("GET", "/api/stm/history", BOB)).payload;

    expect(mine.some((e) => e.query === "alice private prompt")).toBe(true);
    expect(theirs).not.toContain("alice private prompt");
  });

  it("clears only the caller's entries", async () => {
    await call("POST", "/api/stm/history", ALICE, { query: "alice keeps this", modules: [] });
    await call("POST", "/api/stm/history", BOB, { query: "bob keeps this", modules: [] });

    await call("DELETE", "/api/stm/history", ALICE);

    const alice = (
      JSON.parse((await call("GET", "/api/stm/history", ALICE)).payload) as { entries: unknown[] }
    ).entries;
    const bob = (await call("GET", "/api/stm/history", BOB)).payload;

    expect(alice).toEqual([]);
    expect(bob).toContain("bob keeps this");
  });

  it("records the computed parameters with the entry", async () => {
    const res = await call("POST", "/api/stm/history", ALICE, {
      query: "should we hedge this claim?",
      modules: ["hedge"],
      applied: ["hedge"],
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).params).toBeTruthy();

    const { entries } = JSON.parse((await call("GET", "/api/stm/history", ALICE)).payload) as {
      entries: { params: Record<string, unknown> }[];
    };
    expect(entries[0]?.params).toBeTruthy();
  });
});

describe("STM module selection is per user", () => {
  it("does not change another user's active modules", async () => {
    await call("POST", "/api/stm/active", ALICE, { modules: ["ema"] });

    const alice = JSON.parse((await call("GET", "/api/stm/active", ALICE)).payload) as {
      modules: string[];
    };
    const bob = JSON.parse((await call("GET", "/api/stm/active", BOB)).payload) as {
      modules: string[];
    };

    expect(alice.modules).toEqual(["ema"]);
    expect(bob.modules).toEqual(["hedge", "dir", "ema"]);
  });

  it("toggles a module for the caller alone", async () => {
    await call("POST", "/api/stm/toggle", BOB, { moduleId: "dir", enabled: false });

    const bob = JSON.parse((await call("GET", "/api/stm", BOB)).payload) as { active: string[] };
    const alice = JSON.parse((await call("GET", "/api/stm", ALICE)).payload) as {
      active: string[];
    };

    expect(bob.active).not.toContain("dir");
    expect(alice.active).toEqual(["ema"]);
  });

  it("rejects a toggle with no module", async () => {
    const res = await call("POST", "/api/stm/toggle", ALICE, { enabled: true });

    expect(res.statusCode).toBe(400);
  });

  it("keeps project overrides per user and falls back to the owner's default", async () => {
    await call("POST", "/api/stm/project/proj-1", ALICE, { active: ["hedge"] });

    const aliceProject = JSON.parse(
      (await call("GET", "/api/stm/project/proj-1", ALICE)).payload,
    ) as { active: string[] };
    const bobProject = JSON.parse((await call("GET", "/api/stm/project/proj-1", BOB)).payload) as {
      active: string[];
    };

    expect(aliceProject.active).toEqual(["hedge"]);
    expect(bobProject.active).not.toEqual(["hedge"]);
  });
});

describe("STM state outlives the process", () => {
  it("reloads a user's history from the store", async () => {
    await call("POST", "/api/stm/history", ALICE, { query: "survives a restart", modules: [] });

    const store = await import("../../src/lib/stm-store.js");
    store._resetStmStoreForTests();
    await store.loadStmStore();

    expect(store.listStmHistory(ALICE).some((e) => e.query === "survives a restart")).toBe(true);
  });
});
