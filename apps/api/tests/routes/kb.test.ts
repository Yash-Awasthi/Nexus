// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge-base surface route tests — the §16.7 extraction of /kb from
 * api-bridge.ts into routes/kb.ts.
 *
 * Hermetic: the KG store is the in-memory variant (no DATABASE_URL-dependent
 * store is touched — getKG builds InMemoryKGStore when the KG store isn't
 * pg-backed), and the module-level KB store is shared across tests in this
 * file, so each test cleans up the KBs it creates.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface Kb {
  id: string;
  name: string;
  description: string;
  docCount: number;
  createdAt: string;
  documents: { id: string; name: string; size: string; type: string }[];
}

let counter = 0;
function freshName(): string {
  counter += 1;
  return `e2e-kb-${counter}-${Date.now()}`;
}

/** Create a KB and return its id (caller deletes it). */
async function createKb(name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/kb",
    payload: { name, description: "created by kb tests" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<Kb>().id;
}

describe("GET /api/kb", () => {
  it("lists created knowledge bases with a computed docCount", async () => {
    const id = await createKb(freshName());

    const res = await app.inject({ method: "GET", url: "/api/kb" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kbs: Kb[]; total: number }>();
    expect(body.total).toBeGreaterThanOrEqual(1);
    const mine = body.kbs.find((k) => k.id === id);
    expect(mine).toBeDefined();
    expect(mine!.name).toContain("e2e-kb-");
    expect(mine!.docCount).toBe(0);
    expect(mine!.documents).toEqual([]);

    const del = await app.inject({ method: "DELETE", url: `/api/kb/${id}` });
    expect(del.statusCode).toBe(204);
  });
});

describe("POST /api/kb", () => {
  it("creates a knowledge base with sane defaults", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb",
      payload: { name: "Docs KB" },
    });
    expect(res.statusCode).toBe(201);
    const kb = res.json<Kb>();
    expect(kb.name).toBe("Docs KB");
    expect(kb.description).toBe("");
    expect(kb.docCount).toBe(0);
    expect(kb.documents).toEqual([]);

    const del = await app.inject({ method: "DELETE", url: `/api/kb/${kb.id}` });
    expect(del.statusCode).toBe(204);
  });
});

describe("KB documents", () => {
  it("adds documents with type detection, lists and deletes them", async () => {
    const id = await createKb(freshName());

    const doc = await app.inject({
      method: "POST",
      url: `/api/kb/${id}/documents`,
      payload: { name: "report.pdf", size: "1.2 MB" },
    });
    expect(doc.statusCode).toBe(201);
    const added = doc.json<{ id: string; name: string; size: string; type: string }>();
    expect(added.type).toBe("pdf");
    expect(added.id).toMatch(/^doc_/);

    const txt = await app.inject({
      method: "POST",
      url: `/api/kb/${id}/documents`,
      payload: { name: "notes.txt" },
    });
    expect(txt.json<{ type: string; size: string }>().type).toBe("txt");
    expect(txt.json<{ size: string }>().size).toBe("0 KB");

    const list = await app.inject({ method: "GET", url: `/api/kb/${id}/documents` });
    expect(list.json<{ documents: unknown[]; total: number }>().total).toBe(2);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/kb/${id}/documents/${added.id}`,
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: `/api/kb/${id}/documents` });
    expect(after.json<{ total: number }>().total).toBe(1);

    const delKb = await app.inject({ method: "DELETE", url: `/api/kb/${id}` });
    expect(delKb.statusCode).toBe(204);
  });

  it("returns 404 for documents on an unknown knowledge base", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/nope/documents",
      payload: { name: "x.pdf" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "knowledge base not found" });
  });
});

describe("POST /api/kb/:id (KG ingestion alias)", () => {
  it("returns the ingest result shape (current behavior: inert extractors)", async () => {
    const id = await createKb(freshName());
    const res = await app.inject({
      method: "POST",
      url: `/api/kb/${id}`,
      payload: { text: "Alice works at Acme Corp. Bob is a colleague of Alice at Acme Corp." },
    });
    expect(res.statusCode).toBe(201);
    // Current behavior: KnowledgeGraph defaults to null extractors, so the
    // alias round-trips the ingest result with zero entities (flagged in
    // routes/kb.ts — wiring real extractors is a separate slice).
    const body = res.json<{ entities: unknown[]; relationships: unknown[] }>();
    expect(Array.isArray(body.entities)).toBe(true);
    expect(body.entities).toEqual([]);
    expect(Array.isArray(body.relationships)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/kb/${id}` });
    expect(del.statusCode).toBe(204);
  });
});
