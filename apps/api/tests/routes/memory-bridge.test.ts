// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge memory surface route tests — the §16.7 extraction of /api/memory/*
 * from api-bridge.ts into routes/memory-bridge.ts.
 *
 * Hermetic by construction: DATABASE_URL is cleared before building so
 * getMemory() picks the InMemoryStore, and NEXUS_EMBED_PROVIDER is set to an
 * unknown value so createBestEmbedder() falls back to the deterministic
 * FixedEmbedder — no Postgres, no Ollama, no network.
 *
 * The module-level memory manager is shared across tests in this file; each
 * mutating test ends with the delete-all endpoint to reset state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;
let savedDbUrl: string | undefined;

beforeEach(async () => {
  savedDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.NEXUS_EMBED_PROVIDER = "fixed";
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.NEXUS_EMBED_PROVIDER;
  if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
});

interface MemoryEntry {
  id: string;
  text: string;
  topic?: string;
  chunks?: number;
  date?: string;
  source?: string;
  score?: number;
}

/** Write one unique entry and return it. */
async function remember(text: string): Promise<MemoryEntry> {
  const res = await app.inject({
    method: "POST",
    url: "/api/memory/entries",
    payload: { content: text, category: "test" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<MemoryEntry>();
}

describe("POST /api/memory/entries + GET list", () => {
  it("stores an entry and lists it with the UI field mapping", async () => {
    const text = `memory-bridge entry ${Date.now()}`;
    const created = await remember(text);

    const res = await app.inject({ method: "GET", url: "/api/memory/entries" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: MemoryEntry[]; total: number }>();
    expect(body.total).toBeGreaterThanOrEqual(1);
    const mine = body.entries.find((e) => e.id === created.id);
    expect(mine).toBeDefined();
    // UI mapping: topic/chunks/date/source are computed from the raw entry.
    expect(mine!.topic).toContain("memory-bridge entry");
    expect(mine!.chunks).toBeGreaterThanOrEqual(1);
    expect(typeof mine!.date).toBe("string");
    expect(mine!.source).toBe("test");
  });
});

describe("GET /api/memory/entries?query= (recall)", () => {
  it("returns scored recall results", async () => {
    await remember(`quantum entanglement coherence ${Date.now()}`);
    const res = await app.inject({
      method: "GET",
      url: "/api/memory/entries?query=quantum&limit=5",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: MemoryEntry[]; total: number }>();
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    // Recall rows carry a score.
    expect(typeof body.entries[0]!.score).toBe("number");
  });
});

describe("GET /api/memory/stats", () => {
  it("returns total/oldest/newest stats", async () => {
    await remember(`stats entry ${Date.now()}`);
    const res = await app.inject({ method: "GET", url: "/api/memory/stats" });
    expect(res.statusCode).toBe(200);
    const stats = res.json<{ total: number; oldest?: number; newest?: number }>();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(typeof stats.oldest).toBe("number");
  });
});

describe("DELETE /api/memory/entries/:id", () => {
  it("deletes an owned entry and 404s on an unknown one", async () => {
    const created = await remember(`delete me ${Date.now()}`);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/memory/entries/${created.id}`,
    });
    expect(del.statusCode).toBe(204);

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/memory/entries/${created.id}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "memory entry not found" });
  });
});

describe("memory backend config + compact + delete-all", () => {
  it("backend config round-trips (cosmetic single-engine)", async () => {
    for (const method of ["POST", "PUT"] as const) {
      const res = await app.inject({ method, url: "/api/memory/backend" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
  });

  it("compact reports 0 for unique entries", async () => {
    await remember(`unique a ${Date.now()}`);
    await remember(`unique b ${Date.now()}`);
    const res = await app.inject({ method: "POST", url: "/api/memory/compact" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; compacted: number }>()).toEqual({ ok: true, compacted: 0 });
  });

  it("delete-all clears every entry for the caller", async () => {
    await remember(`cleanup a ${Date.now()}`);
    await remember(`cleanup b ${Date.now()}`);
    const res = await app.inject({ method: "DELETE", url: "/api/memory/entries" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; deleted: number }>();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBeGreaterThanOrEqual(2);
  });
});