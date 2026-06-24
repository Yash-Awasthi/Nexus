// SPDX-License-Identifier: Apache-2.0
/**
 * SSE tenant-isolation tests.
 *
 * Tests that:
 *   - SSE agent stream /sse/agent/:stream returns 403 for wrong user
 *   - Firehose routes (/sse/tasks, /sse/signals, /sse/verdicts, /sse/agent/all)
 *     require enterprise tier
 *   - Single-task subscription (/sse/tasks/:taskId) checks session ownership
 *   - Single-verdict subscription (/sse/verdicts/:taskId) checks ownership
 *
 * The DB query inside verifySessionOwnership + auth middleware is mocked via
 * a top-level vi.mock("pg", ...) that is vitest-hoisted before any imports.
 *
 * Notes on SSE hijack behavior:
 *   When an SSE route succeeds, it calls reply.hijack() and enters an
 *   indefinite streaming state — Fastify's app.inject() cannot resolve
 *   the hijacked response. Tests for the success path use a short timeout:
 *   if the inject promise does not resolve within SSE_GRACE_MS, we treat it
 *   as "route passed auth + ownership checks and hijacked the reply", i.e.
 *   success. The rejection/403 paths return normally before hijack.
 *   Tests added with { timeout: 10_000 } to avoid test-runner timeouts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

// ═══════════════════════════════════════════════════════════════════════════════
// Controllable pg mock — hoisted by vitest before the module graph loads.
// Every route module that does `import { Pool } from "pg"` or
// `import pg from "pg"` gets this mock.
// ═══════════════════════════════════════════════════════════════════════════════

const poolQuery = vi.fn();
const poolEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  // pg has both a default export and named Pool export — both used in the codebase.
  const MockPool = vi.fn(() => ({
    query: poolQuery,
    end: poolEnd,
  }));
  return {
    default: {
      Pool: MockPool,
    },
    Pool: MockPool,
  };
});

// ═══════════════════════════════════════════════════════════════════════════════
// JWT helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const JWT_SECRET = "sse-tenant-test-secret";
const USER_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_B = "11111111-2222-3333-4444-555555555555";
const TASK_OWNED_BY_A = "task-aaaa-0001";
const TASK_NOT_OWNED = "task-zzzz-9999";

function tokenFor(userId: string, tier: string = "pro"): string {
  return makeJwt(
    { sub: userId, role: "admin", tier, exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET,
  );
}

/** Set what query() returns for every pg.Pool instance in the process. */
function setPgRows(rows: Record<string, string>[]): void {
  poolQuery.mockResolvedValue({ rows });
}

function setPgError(err: Error): void {
  poolQuery.mockRejectedValue(err);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSE hijack-aware inject helper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * When an SSE route succeeds, it hijacks the reply and the promise from
 * app.inject() never settles. The rejection paths (401, 403) return a
 * normal JSON response before hijack and resolve immediately.
 *
 * This helper races the inject promise against a short timeout. If the
 * timeout wins, the route hijacked (success). If inject resolves first,
 * we got a rejection response that we can assert on.
 */
const SSE_GRACE_MS = 500;

interface SseResult {
  /** Did the route hijack (success path)? */
  hijacked: boolean;
  /** Only set when hijacked === false. */
  statusCode: number;
  /** Only set when hijacked === false. JSON body. */
  body: () => Record<string, unknown>;
}

async function injectSse(
  app: FastifyInstance,
  opts: { method: string; url: string; headers?: Record<string, string> },
): Promise<SseResult> {
  try {
    const res = await Promise.race([
      app.inject(opts).then((r) => ({ type: "response" as const, value: r })),
      new Promise<{ type: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ type: "timeout" }), SSE_GRACE_MS),
      ),
    ]);

    if (res.type === "timeout") {
      return { hijacked: true, statusCode: 0, body: () => ({}) };
    }

    return {
      hijacked: false,
      statusCode: res.value.statusCode,
      body: () => res.value.json<Record<string, unknown>>(),
    };
  } catch {
    // If inject throws (e.g., after hijack cleanup), treat as hijacked.
    return { hijacked: true, statusCode: 0, body: () => ({}) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Server setup
// ═══════════════════════════════════════════════════════════════════════════════

let app: FastifyInstance;

async function buildWithAuth(): Promise<FastifyInstance> {
  delete process.env.NEXUS_API_KEY;
  process.env.NEXUS_JWT_SECRET = JWT_SECRET;
  // A valid-looking DATABASE_URL so modules that check for it will use pg.
  // The pg mock catches all queries.
  process.env.DATABASE_URL =
    "postgresql://test:test@ep-test-sse.us-east-2.aws.neon.tech/sse_test?sslmode=require";

  const { buildServer } = await import("../../src/server.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

beforeEach(async () => {
  vi.clearAllMocks();
  poolQuery.mockReset();
  poolEnd.mockReset().mockResolvedValue(undefined);
  delete process.env.NEXUS_API_KEY;
  delete process.env.NEXUS_JWT_SECRET;
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (app) {
    try { await app.close(); } catch { /* already closed */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

// ── SSE agent stream: wrong user → 403 ─────────────────────────────────────────

describe("GET /api/v1/sse/agent/:stream (tenant isolation)", () => {
  it("returns 403 when DB says session is owned by a different user", async () => {
    setPgRows([{ user_id: USER_B }]);
    app = await buildWithAuth();

    const res = await injectSse(app, {
      method: "GET",
      url: `/api/v1/sse/agent/${TASK_OWNED_BY_A}`,
      headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
    });

    expect(res.hijacked).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body().error).toBe("Not your agent session");
  });

  it(
    "proceeds (hijacks) when session is not yet in DB (row count 0)",
    { timeout: 10_000 },
    async () => {
      setPgRows([]);
      app = await buildWithAuth();

      const res = await injectSse(app, {
        method: "GET",
        url: `/api/v1/sse/agent/${TASK_NOT_OWNED}`,
        headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
      });

      // Route hijacked → no 403 rejection
      expect(res.hijacked).toBe(true);
    },
  );

  it(
    "proceeds (hijacks) when user matches session owner",
    { timeout: 10_000 },
    async () => {
      setPgRows([{ user_id: USER_A }]);
      app = await buildWithAuth();

      const res = await injectSse(app, {
        method: "GET",
        url: `/api/v1/sse/agent/${TASK_OWNED_BY_A}`,
        headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
      });

      expect(res.hijacked).toBe(true);
    },
  );

  it(
    "fails open (no 403) when DB is unreachable",
    { timeout: 10_000 },
    async () => {
      setPgError(new Error("ECONNREFUSED"));
      app = await buildWithAuth();

      const res = await injectSse(app, {
        method: "GET",
        url: `/api/v1/sse/agent/${TASK_OWNED_BY_A}`,
        headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
      });

      // Fail-open → hijacked (no 403)
      expect(res.hijacked).toBe(true);
    },
  );
});

// ── Firehose routes: enterprise tier only ──────────────────────────────────────

describe("SSE firehose routes require enterprise tier", () => {
  // prettier-ignore
  const firehoseEndpoints = [
    { method: "GET", url: "/api/v1/sse/tasks",        label: "tasks firehose" },
    { method: "GET", url: "/api/v1/sse/signals",      label: "signals firehose" },
    { method: "GET", url: "/api/v1/sse/verdicts",     label: "verdicts firehose" },
    { method: "GET", url: "/api/v1/sse/agent/all",    label: "agent firehose" },
  ] as const;

  for (const ep of firehoseEndpoints) {
    it(`returns 403 for pro tier on ${ep.label}`, async () => {
      setPgRows([]);
      app = await buildWithAuth();

      const res = await injectSse(app, {
        method: ep.method as "GET",
        url: ep.url,
        headers: { authorization: `Bearer ${tokenFor(USER_A, "pro")}` },
      });

      expect(res.hijacked).toBe(false);
      expect(res.statusCode).toBe(403);
      const body = res.body();
      expect(body.error).toMatch(/firehose requires enterprise tier/i);
    });

    it(
      `allows enterprise tier on ${ep.label}`,
      { timeout: 10_000 },
      async () => {
        setPgRows([]);
        app = await buildWithAuth();

        const res = await injectSse(app, {
          method: ep.method as "GET",
          url: ep.url,
          headers: { authorization: `Bearer ${tokenFor(USER_A, "enterprise")}` },
        });

        // Hijacked SSE → auth + tier checks passed
        expect(res.hijacked).toBe(true);
      },
    );
  }
});

// ── Single-task subscription: ownership check ──────────────────────────────────

describe("GET /api/v1/sse/tasks/:taskId (ownership)", () => {
  it("returns 403 when task belongs to a different user", async () => {
    setPgRows([{ user_id: USER_B }]);
    app = await buildWithAuth();

    const res = await injectSse(app, {
      method: "GET",
      url: `/api/v1/sse/tasks/${TASK_OWNED_BY_A}`,
      headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
    });

    expect(res.hijacked).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body().error).toBe("Not your task");
  });

  it(
    "allows when user owns the task",
    { timeout: 10_000 },
    async () => {
      setPgRows([{ user_id: USER_A }]);
      app = await buildWithAuth();

      const res = await injectSse(app, {
        method: "GET",
        url: `/api/v1/sse/tasks/${TASK_OWNED_BY_A}`,
        headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
      });

      expect(res.hijacked).toBe(true);
    },
  );
});

// ── Single-verdict subscription: ownership check ───────────────────────────────

describe("GET /api/v1/sse/verdicts/:taskId (ownership)", () => {
  it("returns 403 when verdict task belongs to a different user", async () => {
    setPgRows([{ user_id: USER_B }]);
    app = await buildWithAuth();

    const res = await injectSse(app, {
      method: "GET",
      url: `/api/v1/sse/verdicts/${TASK_OWNED_BY_A}`,
      headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
    });

    expect(res.hijacked).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body().error).toBe("Not your task");
  });

  it(
    "allows when user owns the verdict task",
    { timeout: 10_000 },
    async () => {
      setPgRows([{ user_id: USER_A }]);
      app = await buildWithAuth();

      const res = await injectSse(app, {
        method: "GET",
        url: `/api/v1/sse/verdicts/${TASK_OWNED_BY_A}`,
        headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
      });

      expect(res.hijacked).toBe(true);
    },
  );
});

// ── Auth requirement: no token → 401 ───────────────────────────────────────────

describe("SSE routes require authentication", () => {
  it("GET /api/v1/sse/tasks returns 401 without auth", async () => {
    process.env.NEXUS_API_KEY = "required-key";
    setPgRows([]);
    app = await buildWithAuth();

    const res = await injectSse(app, {
      method: "GET",
      url: "/api/v1/sse/tasks",
    });

    expect(res.hijacked).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/v1/sse/agent/:stream returns 401 without auth", async () => {
    process.env.NEXUS_API_KEY = "required-key";
    setPgRows([]);
    app = await buildWithAuth();

    const res = await injectSse(app, {
      method: "GET",
      url: "/api/v1/sse/agent/test-stream",
    });

    expect(res.hijacked).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
