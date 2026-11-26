// SPDX-License-Identifier: Apache-2.0
/**
 * Saved comparisons, in two layers:
 *
 *  - the arithmetic, as a pure function: overlap, deltas, per-author counts. No server, no
 *    clock, no model — so the numbers in the diff are checked against hand-computed values
 *    rather than against whatever the code happens to print.
 *  - the surface: two of the caller's finished runs can be saved, a stranger's run cannot be
 *    reached, a running run is refused rather than reported with a fake latency, and the
 *    saved diff is a snapshot (a later change to either run does not rewrite it).
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:comparisons";
const SECRET = "comparisons-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);

const { compareRuns, jaccard, summarise, terms, sideMetrics } = await import(
  "../../src/lib/comparison.ts"
);
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

type Run = Parameters<typeof compareRuns>[0];

/** Timestamps relative to now: a discussion older than 30 days is pruned on load. */
const T0 = Date.now() - 10 * 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function run(over: Partial<Run> & { id: string }): Run {
  return {
    topic: "Ship the migration on Friday?",
    digest: "Yes, ship the migration on Friday behind a kill switch.",
    settled: true,
    reason: "settled",
    participants: ["Ada", "Grace"],
    contributions: 2,
    totalTokens: 1_000,
    startedAt: at(0),
    finishedAt: at(60_000),
    entries: [
      { line: 1, at: at(10_000), author: "Ada", kind: "contribution", text: "Ship it with a kill switch." },
      { line: 2, at: at(20_000), author: "Grace", kind: "contribution", text: "Agreed, add rollback steps." },
      { line: 3, at: at(50_000), author: "Chair", kind: "digest", text: "Verdict." },
    ],
    ...over,
  };
}

describe("the arithmetic", () => {
  it("drops stop words and one-letter noise from the terms it compares", () => {
    expect(terms("The ship is a go, and we will roll back")).toEqual(["ship", "go", "roll", "back"]);
  });

  it("scores overlap as a Jaccard index, and treats two silent verdicts as agreement", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("names the terms each side used alone, and reports identical verdicts as identical", () => {
    const left = run({ id: "left" });
    const right = run({ id: "right" });
    const diff = compareRuns(left, right);
    expect(diff.verdict.identical).toBe(true);
    expect(diff.verdict.overlap).toBe(1);
    expect(diff.verdict.onlyLeft).toEqual([]);
    expect(diff.verdict.onlyRight).toEqual([]);
    expect(diff.topic.same).toBe(true);
    expect(diff.cost.delta).toBe(0);
    expect(diff.latency.deltaMs).toBe(0);
    expect(diff.outcome.sameSettled).toBe(true);
  });

  it("measures a changed verdict by the words that moved, not by opinion", () => {
    const diff = compareRuns(
      run({ id: "left" }),
      run({
        id: "right",
        digest: "No, postpone the migration until Monday after the freeze.",
        totalTokens: 1_500,
        finishedAt: at(180_000),
      }),
    );
    expect(diff.verdict.identical).toBe(false);
    expect(diff.verdict.onlyLeft).toContain("yes");
    expect(diff.verdict.onlyRight).toEqual(expect.arrayContaining(["postpone", "monday"]));
    expect(diff.verdict.shared).toEqual(expect.arrayContaining(["migration"]));
    expect(diff.verdict.overlap).toBeGreaterThan(0);
    expect(diff.verdict.overlap).toBeLessThan(1);
    // +500 tokens, +2 minutes, both exact.
    expect(diff.cost.delta).toBe(500);
    expect(diff.cost.ratio).toBe(1.5);
    expect(diff.latency.deltaMs).toBe(120_000);
    expect(summarise(run({ id: "left" }), run({
      id: "right",
      digest: "No, postpone the migration until Monday after the freeze.",
      totalTokens: 1_500,
      finishedAt: at(180_000),
    }))).toMatch(/verdict overlap \d+%, \+500 tokens, \+120s/);
  });

  it("counts per author, and keeps a participant who only spoke in one run", () => {
    const diff = compareRuns(
      run({ id: "left" }),
      run({
        id: "right",
        participants: ["Ada", "Linus"],
        entries: [
          { line: 1, at: at(10_000), author: "Ada", kind: "contribution", text: "Ship it." },
          { line: 2, at: at(20_000), author: "Linus", kind: "contribution", text: "No." },
        ],
      }),
    );
    const byLabel = Object.fromEntries(diff.authors.map((a) => [a.label, a]));
    expect(byLabel.Ada).toMatchObject({ leftEntries: 1, rightEntries: 1 });
    expect(byLabel.Grace).toMatchObject({ leftEntries: 1, rightEntries: 0 });
    expect(byLabel.Linus).toMatchObject({ leftEntries: 0, rightEntries: 1 });
  });

  it("reports no wall time rather than a wrong one when a run never finished", () => {
    const metrics = sideMetrics(run({ id: "open", finishedAt: undefined }));
    expect(metrics.wallMs).toBeNull();
    expect(metrics.contributionsPerMinute).toBeNull();
    expect(metrics.tokensPerContribution).toBe(500);
    const diff = compareRuns(run({ id: "left" }), run({ id: "open", finishedAt: undefined }));
    expect(diff.latency.deltaMs).toBeNull();
  });
});

let app: FastifyInstance;
let base = "";
const finished = (id: string, over: Partial<Run> = {}) =>
  _seedDiscussionForTests({
    ...run({ id, ...over }),
    // The seeded record is a DiscussionRecord: the same fields, plus the owner it belongs to.
    ownerId: owner,
  } as unknown as Parameters<typeof _seedDiscussionForTests>[0]);

async function call(method: string, url: string, body?: unknown, as = auth): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? { ...as } : { ...as, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no listening port");
  base = `http://127.0.0.1:${address.port}`;
}, 120_000);

describe("the surface", () => {
  it("saves a comparison of two finished runs and returns the diff", async () => {
    await finished("cmp-a");
    await finished("cmp-b", {
      digest: "No, postpone the migration until Monday after the freeze.",
      totalTokens: 1_600,
      finishedAt: at(180_000),
    });
    const res = await call("POST", "/api/v1/comparisons", { left: "cmp-a", right: "cmp-b" });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as {
      id: string;
      left: string;
      right: string;
      summary: string;
      diff: { verdict: { identical: boolean }; cost: { delta: number } };
    };
    expect(saved.id).toMatch(/^cmp_/);
    expect(saved.left).toBe("cmp-a");
    expect(saved.right).toBe("cmp-b");
    expect(saved.diff.verdict.identical).toBe(false);
    expect(saved.summary).toContain("+600 tokens");
    // The list is cheap: summary only, no diff.
    const list = (await (await call("GET", "/api/v1/comparisons")).json()) as {
      comparisons: { id: string; diff?: unknown }[];
    };
    expect(list.comparisons.some((c) => c.id === saved.id && c.diff === undefined)).toBe(true);
    const one = (await (await call("GET", `/api/v1/comparisons/${saved.id}`)).json()) as {
      diff?: unknown;
    };
    expect(one.diff).toBeDefined();
  });

  it("keeps the numbers it was saved with, even if the runs change afterwards", async () => {
    await finished("cmp-c");
    await finished("cmp-d");
    const saved = (await (
      await call("POST", "/api/v1/comparisons", { left: "cmp-c", right: "cmp-d" })
    ).json()) as { id: string; diff: { cost: { leftTokens: number } } };
    // Rewrite the left run's cost after the fact.
    await finished("cmp-c", { totalTokens: 999_999 });
    const again = (await (await call("GET", `/api/v1/comparisons/${saved.id}`)).json()) as {
      diff: { cost: { leftTokens: number } };
    };
    expect(again.diff.cost.leftTokens).toBe(saved.diff.cost.leftTokens);
  });

  it("refuses a run the caller does not own, a running run, and comparing a run to itself", async () => {
    await finished("cmp-e");
    await _seedDiscussionForTests({
      ...run({ id: "cmp-other" }),
      ownerId: other,
    } as unknown as Parameters<typeof _seedDiscussionForTests>[0]);
    await _seedDiscussionForTests({
      ...run({ id: "cmp-running", finishedAt: undefined }),
      ownerId: owner,
    } as unknown as Parameters<typeof _seedDiscussionForTests>[0]);

    expect((await call("POST", "/api/v1/comparisons", { left: "cmp-e", right: "cmp-other" })).status).toBe(404);
    expect((await call("POST", "/api/v1/comparisons", { left: "cmp-e", right: "cmp-e" })).status).toBe(400);
    const running = await call("POST", "/api/v1/comparisons", { left: "cmp-e", right: "cmp-running" });
    expect(running.status).toBe(409);
    expect(((await running.json()) as { message: string }).message).toMatch(/must be finished/);
    expect((await call("POST", "/api/v1/comparisons", {})).status).toBe(400);
  });

  it("deletes one, and another account cannot see or delete it", async () => {
    await finished("cmp-f");
    await finished("cmp-g");
    const saved = (await (
      await call("POST", "/api/v1/comparisons", { left: "cmp-f", right: "cmp-g", label: "Friday A/B" })
    ).json()) as { id: string; label: string };
    expect(saved.label).toBe("Friday A/B");
    const otherAuth = { authorization: `Bearer ${tokenFor(other)}` };
    expect((await call("GET", `/api/v1/comparisons/${saved.id}`, undefined, otherAuth)).status).toBe(404);
    expect((await call("DELETE", `/api/v1/comparisons/${saved.id}`, undefined, otherAuth)).status).toBe(404);
    expect((await call("DELETE", `/api/v1/comparisons/${saved.id}`)).status).toBe(204);
    expect((await call("GET", `/api/v1/comparisons/${saved.id}`)).status).toBe(404);
  });
});
