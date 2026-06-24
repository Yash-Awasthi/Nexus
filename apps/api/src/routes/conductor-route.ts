// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — Conductor orchestration routes
 *
 * Exposes the Conductor multi-agent runtime as a REST API:
 *   POST /api/gs/submit          — submit objective, run to completion
 *   GET  /api/gs/status          — queue length + active jobs
 *   GET  /api/gs/dead-letter     — dead-letter queue
 *   DELETE /api/gs/dead-letter   — clear dead-letter queue
 *   GET  /api/gs/health          — runtime health
 *
 * The orchestrator is initialised lazily on first request so the API
 * server starts instantly even if the runtime deps aren't warm.
 */

import { createGhostStackOrchestrator, type GhostStackOrchestrator } from "@nexus/runtime";
import type { FastifyInstance } from "fastify";

interface GSQueueBackend {
  getQueueLength(): Promise<number>;
  getActiveJobs(): Promise<unknown[]>;
  getDeadLetterQueue(): Promise<unknown[]>;
  clearDeadLetterQueue(): Promise<void>;
}

let _gs: GhostStackOrchestrator | null = null;
let _queue: GSQueueBackend | null = null;
let _initError: string | null = null;

const _jobLog: {
  id: string;
  objective: string;
  status: "running" | "done" | "failed" | "blocked";
  result?: { planId: string; allowed: boolean; reason?: string; processed: number };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}[] = [];

async function _getOrchestrator(): Promise<GhostStackOrchestrator> {
  if (_gs) return _gs;
  if (_initError) throw new Error(_initError);
  try {
    // Build the orchestrator from @nexus/runtime. The shared queue instance is
    // surfaced so status/DLQ endpoints reflect live state.
    const { orchestrator, queue } = createGhostStackOrchestrator();
    _gs = orchestrator;
    _queue = queue;
    await _gs.start();
    return _gs;
  } catch (e) {
    _initError = e instanceof Error ? e.message : String(e);
    throw new Error(_initError);
  }
}

export async function conductorRoutes(app: FastifyInstance) {
  // POST /gs/submit — submit an objective and run to completion
  app.post<{ Body: { objective: string; maxIterations?: number } }>(
    "/gs/submit",
    async (req, reply) => {
      const { objective, maxIterations = 50 } = req.body ?? {};
      if (!objective) return reply.code(400).send({ error: "objective is required" });

      const jobId = crypto.randomUUID();
      const entry = {
        id: jobId,
        objective,
        status: "running" as const,
        startedAt: new Date().toISOString(),
      };
      _jobLog.push(entry);
      if (_jobLog.length > 200) _jobLog.splice(0, _jobLog.length - 200);

      try {
        const orchestrator = await _getOrchestrator();
        const result = await orchestrator.submitAndRun(objective, {
          maxIterations,
          idleDelayMs: 50,
        });
        Object.assign(entry, { status: "done", result, finishedAt: new Date().toISOString() });
        return reply.send({ jobId, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        Object.assign(entry, {
          status: "failed",
          error: msg,
          finishedAt: new Date().toISOString(),
        });
        return reply.code(500).send({ error: msg, jobId });
      }
    },
  );

  // GET /gs/jobs — list recent job log
  app.get("/gs/jobs", async (_req, reply) => {
    return reply.send({ jobs: [..._jobLog].reverse(), total: _jobLog.length });
  });

  // GET /gs/status — queue depth + active jobs
  app.get("/gs/status", async (_req, reply) => {
    try {
      if (!_queue) {
        return reply.send({
          initialised: false,
          queueLength: 0,
          activeJobs: [],
          deadLetterCount: 0,
        });
      }
      const [queueLength, activeJobs, dlq] = await Promise.all([
        _queue.getQueueLength(),
        _queue.getActiveJobs(),
        _queue.getDeadLetterQueue(),
      ]);
      return reply.send({
        initialised: !!_gs,
        queueLength,
        activeJobs,
        deadLetterCount: dlq.length,
        recentJobs: _jobLog.slice(-10).reverse(),
      });
    } catch (e) {
      return reply.send({ initialised: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // GET /gs/dead-letter
  app.get("/gs/dead-letter", async (_req, reply) => {
    if (!_queue) return reply.send({ jobs: [] });
    const dlq = await _queue.getDeadLetterQueue();
    return reply.send({ jobs: dlq, count: dlq.length });
  });

  // DELETE /gs/dead-letter — clear DLQ
  app.delete("/gs/dead-letter", async (_req, reply) => {
    if (_queue) await _queue.clearDeadLetterQueue();
    return reply.send({ ok: true, cleared: true });
  });

  // GET /gs/health
  app.get("/gs/health", async (_req, reply) => {
    return reply.send({
      ok: !_initError,
      initialised: !!_gs,
      error: _initError,
      version: "1.2.0",
      jobs: _jobLog.length,
    });
  });
}

/**
 * Snapshot of GhostStack runtime metrics for Prometheus scraping.
 * Safe to call before GhostStack is initialised — returns zeros in that case.
 */
export async function getConductorMetrics(): Promise<{
  initialised: boolean;
  jobsTotal: number;
  jobsDone: number;
  jobsFailed: number;
  jobsBlocked: number;
  jobsRunning: number;
  queueLength: number;
  activeJobs: number;
  deadLetterCount: number;
  initError: string | null;
}> {
  const base = {
    initialised: !!_gs,
    jobsTotal: _jobLog.length,
    jobsDone: _jobLog.filter((j) => j.status === "done").length,
    jobsFailed: _jobLog.filter((j) => j.status === "failed").length,
    jobsBlocked: _jobLog.filter((j) => j.status === "blocked").length,
    jobsRunning: _jobLog.filter((j) => j.status === "running").length,
    queueLength: 0,
    activeJobs: 0,
    deadLetterCount: 0,
    initError: _initError,
  };
  if (!_queue) return base;
  try {
    const [ql, aj, dlq] = await Promise.all([
      _queue.getQueueLength(),
      _queue.getActiveJobs(),
      _queue.getDeadLetterQueue(),
    ]);
    return {
      ...base,
      queueLength: ql,
      activeJobs: aj.length,
      deadLetterCount: dlq.length,
    };
  } catch {
    return base;
  }
}
