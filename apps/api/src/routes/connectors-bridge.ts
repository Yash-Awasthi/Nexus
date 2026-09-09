// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge connectors surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * The legacy `/api/connectors/*` surface (distinct from the v1
 * `/api/v1/connectors` surface in routes/connectors.ts): in-memory
 * (PersistentStore) connector registry + sync-job/schedule bookkeeping with
 * byte-identical response shapes. The seed mirrors the v1 connector registry
 * (groq/tavily/github/neon/slack/linear/notion/bitbucket/jira) so the sync
 * panel works for them — only when the store is empty, never clobbering
 * user-added connectors.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";

const now = (): string => new Date().toISOString();

const _connectors = new PersistentStore<{
  id: string;
  type: string;
  status: string;
  label: string;
}>("connectors");
const _connectorSyncJobs = new PersistentStore<{
  id: string;
  connectorId: string;
  status: string;
  items: number;
  startedAt: string;
  finishedAt: string;
}>("connector_sync_jobs");
const _connectorSyncSchedules = new PersistentStore<{
  id: string;
  connectorId: string;
  syncMode: "load" | "poll" | "slim";
  cronExpression: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}>("connector_sync_schedules");

// Map a persisted job row to the UI contract (ConnectorSyncPanel / connectors-sync):
// { id, connectorId, syncMode, status, startedAt, completedAt, documentsProcessed,
//   documentsDeleted, errorMessage, createdAt }
const toSyncJob = (j: {
  id: string;
  connectorId: string;
  status: string;
  items: number;
  startedAt: string;
  finishedAt: string;
}) => ({
  id: j.id,
  connectorId: j.connectorId,
  syncMode: "load" as const,
  status: j.status,
  startedAt: j.startedAt,
  completedAt: j.finishedAt,
  documentsProcessed: j.items,
  documentsDeleted: 0,
  errorMessage: null,
  createdAt: j.startedAt,
});

/** Register the /connectors/* bridge surface. Called from apiBridgeRoutes. */
export async function connectorsBridgeRoutes(app: FastifyInstance): Promise<void> {
  await Promise.all([
    _connectors.load(),
    _connectorSyncJobs.load(),
    _connectorSyncSchedules.load(),
  ]);

  // Seed the bridge connector store with the registry connectors (v1
  // /connectors in connectors.ts registers groq/tavily/github/neon/slack/
  // linear/notion/bitbucket/jira) so the sync panel works for them. Only when
  // empty — never clobber user-added connectors.
  if (_connectors.size === 0) {
    const seed = [
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
    for (const id of seed) {
      _connectors.set(id, { id, type: id, status: "connected", label: id });
    }
  }

  app.get("/connectors", async (_req, reply) => {
    return reply.send({ connectors: Array.from(_connectors.values()) });
  });

  app.post<{ Body: { type?: string; label?: string; [k: string]: unknown } }>(
    "/connectors",
    async (request, reply) => {
      const id = crypto.randomUUID();
      const { type = "custom", label = "Connector" } = request.body;
      _connectors.set(id, { id, type, label, status: "connected" });
      return reply.code(201).send({ id, type, label, status: "connected" });
    },
  );

  app.delete<{ Params: { id: string } }>("/connectors/:id", async (request, reply) => {
    _connectors.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    "/connectors/:id/sync-jobs",
    async (request, reply) => {
      const { id } = request.params;
      const statuses = (request.query.status ?? "").split(",").filter(Boolean);
      const limit = Number(request.query.limit ?? 50) || 50;
      let jobs = Array.from(_connectorSyncJobs.values())
        .filter((j) => j.connectorId === id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(toSyncJob);
      if (statuses.length > 0) jobs = jobs.filter((j) => statuses.includes(j.status));
      jobs = jobs.slice(0, limit);
      return reply.send({ jobs, total: jobs.length });
    },
  );

  app.post<{ Params: { id: string } }>("/connectors/:id/sync", async (request, reply) => {
    const connectorId = request.params.id;
    if (!_connectors.has(connectorId)) {
      return reply.code(404).send({ error: "connector_not_found" });
    }
    // Synchronous local sync: record a completed job row. A real remote connector
    // would enqueue work; here we persist an auditable job with a timestamp.
    const startedAt = now();
    const job = {
      id: crypto.randomUUID(),
      connectorId,
      status: "completed",
      items: 0,
      startedAt,
      finishedAt: now(),
    };
    _connectorSyncJobs.set(job.id, job);
    // Mark any schedule for this connector as last-run now.
    for (const s of _connectorSyncSchedules.values()) {
      if (s.connectorId === connectorId) {
        _connectorSyncSchedules.set(s.id, { ...s, lastRunAt: now() });
      }
    }
    return reply.code(201).send(toSyncJob(job));
  });

  // -- Connector sync panel (ConnectorSyncPanel.tsx) --------------------------

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/connectors/:id/sync/jobs",
    async (request, reply) => {
      const { id } = request.params;
      const limit = Number(request.query.limit ?? 50) || 50;
      const jobs = Array.from(_connectorSyncJobs.values())
        .filter((j) => j.connectorId === id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map(toSyncJob);
      return reply.send({ jobs });
    },
  );

  app.delete<{ Params: { id: string; jobId: string } }>(
    "/connectors/:id/sync/jobs/:jobId",
    async (request, reply) => {
      const { id, jobId } = request.params;
      const job = _connectorSyncJobs.get(jobId);
      if (!job || job.connectorId !== id) {
        return reply.code(404).send({ error: "job_not_found" });
      }
      _connectorSyncJobs.delete(jobId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/connectors/:id/sync/schedules", async (request, reply) => {
    const schedules = Array.from(_connectorSyncSchedules.values()).filter(
      (s) => s.connectorId === request.params.id,
    );
    return reply.send({ schedules });
  });

  app.post<{
    Params: { id: string };
    Body: { syncMode?: string; cronExpression?: string; enabled?: boolean };
  }>("/connectors/:id/sync/schedules", async (request, reply) => {
    const connectorId = request.params.id;
    if (!_connectors.has(connectorId)) {
      return reply.code(404).send({ error: "connector_not_found" });
    }
    const schedule = {
      id: crypto.randomUUID(),
      connectorId,
      syncMode: (request.body.syncMode === "poll" || request.body.syncMode === "slim"
        ? request.body.syncMode
        : "load") as "load" | "poll" | "slim",
      cronExpression: request.body.cronExpression ?? "0 * * * *",
      enabled: request.body.enabled ?? true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now(),
    };
    _connectorSyncSchedules.set(schedule.id, schedule);
    return reply.code(201).send(schedule);
  });

  app.patch<{
    Params: { id: string; scheduleId: string };
    Body: Partial<{
      syncMode: string;
      cronExpression: string;
      enabled: boolean;
    }>;
  }>("/connectors/:id/sync/schedules/:scheduleId", async (request, reply) => {
    const { id, scheduleId } = request.params;
    const existing = _connectorSyncSchedules.get(scheduleId);
    if (!existing || existing.connectorId !== id) {
      return reply.code(404).send({ error: "schedule_not_found" });
    }
    const updated = {
      ...existing,
      ...(request.body as Partial<typeof existing>),
    };
    _connectorSyncSchedules.set(scheduleId, updated);
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    "/connectors/:id/sync/schedules/:scheduleId",
    async (request, reply) => {
      const { id, scheduleId } = request.params;
      const existing = _connectorSyncSchedules.get(scheduleId);
      if (!existing || existing.connectorId !== id) {
        return reply.code(404).send({ error: "schedule_not_found" });
      }
      _connectorSyncSchedules.delete(scheduleId);
      return reply.code(204).send();
    },
  );
}
