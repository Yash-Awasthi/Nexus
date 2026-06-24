// SPDX-License-Identifier: Apache-2.0
/**
 * Regression oracle for the Conductor orchestration routes (/api/v1/gs/*).
 *
 * Captures the behavior of the route BEFORE the conductor→runtime consolidation
 * so that migrating the route from @nexus/conductor to @nexus/runtime cannot
 * silently change the HTTP contract. See .claude/CONDUCTOR_RUNTIME_CONSOLIDATION.md.
 *
 * Locked (exact) contracts:
 *   - GET  /gs/health       before init
 *   - GET  /gs/status       before init
 *   - GET  /gs/dead-letter  before/after init
 *   - POST /gs/submit  {}   → 400 validation
 *   - POST /gs/submit {objective} → 200 with { jobId, planId, allowed, processed };
 *     the job is recorded and reflected by /gs/status and /gs/jobs.
 *
 * HISTORY: the original conductor-backed submit path returned 500
 * ("Cognitive Planning and Governance systems are not registered in the
 * Orchestrator.") because the route never registered those engines. After the
 * consolidation, createGhostStackOrchestrator() (in @nexus/runtime) wires an
 * offline PlanningEngine + GovernanceEngine + TaskExecutor, so submit now plans
 * and dispatches deterministically without an LLM key or live infra.
 */
import { describe, it, expect, vi } from "vitest";

// Mirror the @nexus/db mock used by the other route tests so buildServer() boots
// without live Postgres.
vi.mock("@nexus/db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

import { buildServer } from "../../src/server.js";

const P = "/api/v1/gs";

describe("Conductor routes /api/v1/gs/* (regression oracle)", () => {
  it("GET /gs/health before init returns the uninitialised snapshot", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: `${P}/health` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      initialised: false,
      error: null,
      version: "1.2.0",
      jobs: 0,
    });
    await app.close();
  });

  it("GET /gs/status before init returns zeros", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: `${P}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      initialised: false,
      queueLength: 0,
      activeJobs: [],
      deadLetterCount: 0,
    });
    await app.close();
  });

  it("GET /gs/dead-letter before init returns an empty list", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: `${P}/dead-letter` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobs: [] });
    await app.close();
  });

  it("POST /gs/submit without objective returns 400", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "POST", url: `${P}/submit`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "objective is required" });
    await app.close();
  });

  it("POST /gs/submit with objective returns a jobId and records the job", async () => {
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `${P}/submit`,
      payload: { objective: "regression oracle objective", maxIterations: 3 },
    });
    const body = res.json() as {
      jobId?: string;
      planId?: string;
      allowed?: boolean;
      processed?: number;
    };
    // The orchestrator is now fully wired (planning + governance + executor),
    // so submit plans + dispatches offline and returns 200 with a plan result.
    expect(res.statusCode).toBe(200);
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId).toBeTruthy();
    expect(typeof body.planId).toBe("string");
    expect(body.allowed).toBe(true);
    expect(typeof body.processed).toBe("number");

    // The job must be discoverable via /gs/jobs ...
    const jobs = (await app.inject({ method: "GET", url: `${P}/jobs` })).json() as {
      jobs: { id: string; objective: string }[];
      total: number;
    };
    expect(jobs.total).toBeGreaterThanOrEqual(1);
    expect(jobs.jobs.some((j) => j.id === body.jobId)).toBe(true);
    expect(jobs.jobs.some((j) => j.objective === "regression oracle objective")).toBe(true);

    // ... and /gs/status must now report the orchestrator as initialised.
    const status = (await app.inject({ method: "GET", url: `${P}/status` })).json() as {
      initialised: boolean;
      queueLength: number;
    };
    expect(status.initialised).toBe(true);
    expect(typeof status.queueLength).toBe("number");

    await app.close();
  });

  it("DELETE /gs/dead-letter clears and acks", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: `${P}/dead-letter` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cleared: true });
    await app.close();
  });
});
