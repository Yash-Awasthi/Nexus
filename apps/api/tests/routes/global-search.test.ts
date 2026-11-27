// SPDX-License-Identifier: Apache-2.0
/**
 * Global search: one box, typed results.
 *
 * The properties worth pinning are the ones that make a merged result list trustworthy —
 * a hit carries a type and a link to where it lives, the per-type counts are computed before
 * the global limit (so "12 more in workflows" is true), the type filter actually filters, one
 * account cannot find another's rows, and a query that matched nothing anywhere says so
 * instead of looking like an empty account.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:global-search";
const SECRET = "global-search-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
const { _seedDiscussionForTests } = await import("../../src/routes/discussion.ts");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const owner = crypto.randomUUID();
const other = crypto.randomUUID();
const auth = { authorization: `Bearer ${tokenFor(owner)}` };
const otherAuth = { authorization: `Bearer ${tokenFor(other)}` };

let app: FastifyInstance;
let base = "";

async function call(method: string, url: string, body?: unknown, as = auth): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? { ...as } : { ...as, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Result {
  query: string;
  total: number;
  results: {
    type: string;
    id: string;
    title: string;
    snippet: string;
    link: string;
    score: number;
  }[];
  counts: Record<string, number>;
  notes: string[];
  filteredBy: string[] | null;
}

const search = async (q: string, extra = "", as = auth): Promise<Result> =>
  (await (
    await call("GET", `/api/v1/search?q=${encodeURIComponent(q)}${extra}`, undefined, as)
  ).json()) as Result;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no listening port");
  base = `http://127.0.0.1:${address.port}`;

  // A session, a discussion, a workflow and a knowledge base, all mentioning "migration".
  const thread = await call("POST", "/api/threads", { title: "Migration on Friday" });
  const { id } = (await thread.json()) as { id: string };
  await call("POST", `/api/threads/${id}/messages`, {
    messages: [{ id: "m1", role: "user", content: "Should the migration ship on Friday?" }],
  });
  await _seedDiscussionForTests({
    id: "d-migration",
    ownerId: owner,
    topic: "Migration rollout order",
    participants: ["Ada"],
    entries: [],
    digest: "Ship the migration behind a kill switch.",
    settled: true,
    reason: "settled",
    contributions: 1,
    totalTokens: 10,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof _seedDiscussionForTests>[0]);
  await call("POST", "/api/workflows", { name: "migration-checks", steps: [{ kind: "fn" }] });
  const kb = await call("POST", "/api/kb", { name: "migration-notes", description: "Runbook" });
  if (kb.ok) {
    const { id: kbId } = (await kb.json()) as { id: string };
    await call("POST", `/api/kb/${kbId}/documents`, { name: "migration.md", text: "steps" });
  }
});

describe("one result list with types", () => {
  it("finds a session, a discussion and a workflow, and names each one's type and link", async () => {
    const found = await search("migration");
    expect(found.total).toBeGreaterThanOrEqual(3);
    const types = new Set(found.results.map((r) => r.type));
    expect(types.has("session")).toBe(true);
    expect(types.has("discussion")).toBe(true);
    expect(types.has("workflow")).toBe(true);
    for (const result of found.results) {
      expect(result.link).toMatch(/^\//);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(0);
    }
    // Counts are per type and computed before the limit, so they can exceed results.length.
    expect(found.counts.workflow).toBeGreaterThanOrEqual(1);
    expect(found.filteredBy).toBeNull();
  });

  it("ranks a title match above a body match", async () => {
    const found = await search("friday");
    const byScore = [...found.results].map((r) => r.score);
    expect(byScore).toEqual([...byScore].sort((a, b) => b - a));
    expect(found.results[0]!.title.toLowerCase()).toContain("friday");
  });

  it("filters by type when asked, and reports what it filtered by", async () => {
    const found = await search("migration", "&types=discussion");
    expect(found.filteredBy).toEqual(["discussion"]);
    expect(found.results.every((r) => r.type === "discussion")).toBe(true);
    expect(found.counts.session).toBeUndefined();
  });

  it("honours the limit without lying about the totals", async () => {
    const one = await search("migration", "&limit=1");
    expect(one.results).toHaveLength(1);
    expect(one.total).toBeGreaterThan(1);
  });

  it("refuses a query shorter than two characters", async () => {
    const short = await call("GET", "/api/v1/search?q=a");
    expect(short.status).toBe(400);
    expect((await call("GET", "/api/v1/search")).status).toBe(400);
  });

  it("returns an empty list, and says why, when nothing matches", async () => {
    const found = await search("zzzz-nothing-matches");
    expect(found.total).toBe(0);
    expect(found.results).toEqual([]);
    // The graph is a real source and it had nothing: a silent zero would look like an empty
    // account rather than an empty graph.
    expect(found.notes.some((note) => note.includes("knowledge graph"))).toBe(true);
  });

  it("cannot reach another account's rows", async () => {
    const found = await search("migration", "", otherAuth);
    const mine = await search("migration");
    expect(found.total).toBeLessThanOrEqual(mine.total);
    expect(found.results.some((r) => r.type === "discussion")).toBe(false);
  });
});
