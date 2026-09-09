// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge connectors surface route tests — the §16.7 extraction of
 * /connectors/* from api-bridge.ts into routes/connectors-bridge.ts.
 *
 * The module-level PersistentStores are shared across tests in this file, so
 * each test creates its own uniquely-named connector and cleans up after
 * itself. The seed (9 registry connectors) runs once on the first build.
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

interface Connector {
  id: string;
  type: string;
  status: string;
  label: string;
}

interface SyncJob {
  id: string;
  connectorId: string;
  syncMode: "load";
  status: string;
  startedAt: string;
  completedAt: string;
  documentsProcessed: number;
  documentsDeleted: number;
  errorMessage: null;
  createdAt: string;
}

interface Schedule {
  id: string;
  connectorId: string;
  syncMode: "load" | "poll" | "slim";
  cronExpression: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

let counter = 0;
/** Fresh connector id unique to this test file (module stores are shared). */
function freshConnector(): string {
  counter += 1;
  return `e2e-conn-${counter}-${Date.now()}`;
}

describe("GET /api/connectors (seeded registry)", () => {
  it("lists the nine seeded registry connectors", async () => {
    const res = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(res.statusCode).toBe(200);
    const connectors = res.json<{ connectors: Connector[] }>().connectors;
    const seeded = [
      "groq",
      "tavily",
      "github",
      "neon",
      "slack",
      "linear",
      "notion",
      "bitbucket",
      "jira",
    ];
    for (const id of seeded) {
      const c = connectors.find((x) => x.id === id);
      expect(c).toBeDefined();
      expect(c!.status).toBe("connected");
      expect(c!.type).toBe(id);
    }
  });
});

describe("POST/DELETE /api/connectors", () => {
  it("creates a connector and lists it, then deletes it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: { type: "custom", label: "Probe Connector" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<Connector>();
    expect(body.type).toBe("custom");
    expect(body.label).toBe("Probe Connector");
    expect(body.status).toBe("connected");

    // The id is generated server-side; it appears in the listing.
    const realId = body.id;
    const list = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(list.json<{ connectors: Connector[] }>().connectors.some((c) => c.id === realId)).toBe(
      true,
    );

    const del = await app.inject({ method: "DELETE", url: `/api/connectors/${realId}` });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(after.json<{ connectors: Connector[] }>().connectors.some((c) => c.id === realId)).toBe(
      false,
    );
  });
});

describe("POST /api/connectors/:id/sync (sync jobs)", () => {
  it("records a completed job and marks schedules last-run", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: { type: "custom", label: freshConnector() },
    });
    const connectorId = created.json<Connector>().id;
    // A schedule to observe the lastRunAt touch.
    const sched = await app.inject({
      method: "POST",
      url: `/api/connectors/${connectorId}/sync/schedules`,
      payload: { syncMode: "poll", cronExpression: "*/5 * * * *" },
    });
    const scheduleId = sched.json<Schedule>().id;

    const sync = await app.inject({
      method: "POST",
      url: `/api/connectors/${connectorId}/sync`,
    });
    expect(sync.statusCode).toBe(201);
    const job = sync.json<SyncJob>();
    expect(job.connectorId).toBe(connectorId);
    expect(job.status).toBe("completed");
    expect(job.syncMode).toBe("load");
    expect(job.documentsProcessed).toBe(0);
    expect(job.errorMessage).toBeNull();

    // The schedule now shows lastRunAt.
    const schedules = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/sync/schedules`,
    });
    const after = schedules
      .json<{ schedules: Schedule[] }>()
      .schedules.find((s) => s.id === scheduleId);
    expect(after!.lastRunAt).toBeTruthy();
  });

  it("returns 404 connector_not_found for an unknown connector", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/connectors/does-not-exist/sync",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "connector_not_found" });
  });
});

describe("GET/DELETE sync jobs", () => {
  it("lists, filters and deletes jobs for one connector", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: { type: "custom", label: freshConnector() },
    });
    const connectorId = created.json<Connector>().id;
    const sync = await app.inject({
      method: "POST",
      url: `/api/connectors/${connectorId}/sync`,
    });
    const jobId = sync.json<SyncJob>().id;

    // Both job surfaces list the job.
    for (const url of [
      `/api/connectors/${connectorId}/sync-jobs`,
      `/api/connectors/${connectorId}/sync/jobs`,
    ]) {
      const list = await app.inject({ method: "GET", url });
      const jobs = list.json<{ jobs: SyncJob[] }>().jobs;
      expect(jobs.some((j) => j.id === jobId)).toBe(true);
    }

    // Status filter only returns matching jobs.
    const filtered = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/sync-jobs?status=completed`,
    });
    expect(filtered.json<{ jobs: SyncJob[] }>().jobs.some((j) => j.id === jobId)).toBe(true);
    const noMatch = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/sync-jobs?status=running`,
    });
    expect(noMatch.json<{ jobs: SyncJob[] }>().jobs.some((j) => j.id === jobId)).toBe(false);

    // Wrong owner → 404 job_not_found.
    const wrongOwner = await app.inject({
      method: "DELETE",
      url: `/api/connectors/other-connector/sync/jobs/${jobId}`,
    });
    expect(wrongOwner.statusCode).toBe(404);
    expect(wrongOwner.json()).toEqual({ error: "job_not_found" });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connectorId}/sync/jobs/${jobId}`,
    });
    expect(del.statusCode).toBe(204);
  });
});

describe("sync schedules round trip", () => {
  it("creates, patches, lists and deletes a schedule with 404s", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: { type: "custom", label: freshConnector() },
    });
    const connectorId = created.json<Connector>().id;

    const schedRes = await app.inject({
      method: "POST",
      url: `/api/connectors/${connectorId}/sync/schedules`,
      payload: { syncMode: "slim", cronExpression: "0 */6 * * *", enabled: true },
    });
    expect(schedRes.statusCode).toBe(201);
    const schedule = schedRes.json<Schedule>();
    expect(schedule.syncMode).toBe("slim");
    expect(schedule.cronExpression).toBe("0 */6 * * *");
    expect(schedule.enabled).toBe(true);
    expect(schedule.lastRunAt).toBeNull();

    // Unknown connector → 404 connector_not_found.
    const badConn = await app.inject({
      method: "POST",
      url: "/api/connectors/nope/sync/schedules",
      payload: {},
    });
    expect(badConn.statusCode).toBe(404);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/connectors/${connectorId}/sync/schedules/${schedule.id}`,
      payload: { enabled: false, syncMode: "poll" },
    });
    expect(patched.statusCode).toBe(200);
    const updated = patched.json<Schedule>();
    expect(updated.enabled).toBe(false);
    expect(updated.syncMode).toBe("poll");

    // Wrong owner → 404 schedule_not_found.
    const wrongOwner = await app.inject({
      method: "PATCH",
      url: `/api/connectors/other-connector/sync/schedules/${schedule.id}`,
      payload: { enabled: true },
    });
    expect(wrongOwner.statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/sync/schedules`,
    });
    expect(list.json<{ schedules: Schedule[] }>().schedules.some((s) => s.id === schedule.id)).toBe(
      true,
    );

    const del = await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connectorId}/sync/schedules/${schedule.id}`,
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/sync/schedules`,
    });
    expect(after.json<{ schedules: Schedule[] }>().schedules).toHaveLength(0);
  });
});
