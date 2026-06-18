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
 * server starts instantly even if GhostStack deps aren't warm.
 */

import type { FastifyInstance } from "fastify";
import { createRequire } from "node:module";

// GhostStack is CJS — load via createRequire from the ESM API host
const _require = createRequire(import.meta.url);

interface GSModule {
  GhostStackOrchestrator: {
    create(opts: {
      runtimeManager: unknown;
      eventBus: unknown;
      taskRouter: unknown;
      agentRegistry: unknown;
    }): {
      start(): Promise<string[]>;
      submitAndRun(
        objective: string,
        opts?: { maxIterations?: number; idleDelayMs?: number }
      ): Promise<{ planId: string; allowed: boolean; reason?: string; processed: number }>;
    };
  };
  PlanningEngine: new () => unknown;
  GovernanceEngine: new () => unknown;
  TaskRouter: new (opts: { agentRegistry: unknown }) => unknown;
  LocalAgentRegistry: new () => unknown;
  LocalEventBus: new () => unknown;
  RuntimeManager: new (opts: { services: Record<string, unknown> }) => unknown;
  MemoryQueueBackend: new () => {
    getQueueLength(): Promise<number>;
    getActiveJobs(): Promise<unknown[]>;
    getDeadLetterQueue(): Promise<unknown[]>;
    clearDeadLetterQueue(): Promise<void>;
  };
}

let _gs: ReturnType<GSModule["GhostStackOrchestrator"]["create"]> | null = null;
let _queue: ReturnType<GSModule["MemoryQueueBackend"]["prototype"]["constructor"]> | null = null;
let _initError: string | null = null;

const _jobLog: Array<{
  id: string;
  objective: string;
  status: "running" | "done" | "failed" | "blocked";
  result?: { planId: string; allowed: boolean; reason?: string; processed: number };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}> = [];

async function _getOrchestrator(): Promise<ReturnType<GSModule["GhostStackOrchestrator"]["create"]>> {
  if (_gs) return _gs;
  if (_initError) throw new Error(_initError);
  try {
    const gs = _require("@nexus/conductor") as GSModule;
    const agentRegistry = new gs.LocalAgentRegistry();
    const eventBus = new gs.LocalEventBus();
    const runtimeManager = new gs.RuntimeManager({ services: {} });
    const taskRouter = new gs.TaskRouter({ agentRegistry });
    _queue = new gs.MemoryQueueBackend();
    _gs = gs.GhostStackOrchestrator.create({
      runtimeManager,
      eventBus,
      taskRouter,
      agentRegistry,
    });
    await (_gs as unknown as { start(): Promise<string[]> }).start();
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
        Object.assign(entry, { status: "failed", error: msg, finishedAt: new Date().toISOString() });
        return reply.code(500).send({ error: msg, jobId });
      }
    }
  );

  // GET /gs/jobs — list recent job log
  app.get("/gs/jobs", async (_req, reply) => {
    return reply.send({ jobs: [..._jobLog].reverse(), total: _jobLog.length });
  });

  // GET /gs/status — queue depth + active jobs
  app.get("/gs/status", async (_req, reply) => {
    try {
      if (!_queue) {
        return reply.send({ initialised: false, queueLength: 0, activeJobs: [], deadLetterCount: 0 });
      }
      const [queueLength, activeJobs, dlq] = await Promise.all([
        (_queue as { getQueueLength(): Promise<number> }).getQueueLength(),
        (_queue as { getActiveJobs(): Promise<unknown[]> }).getActiveJobs(),
        (_queue as { getDeadLetterQueue(): Promise<unknown[]> }).getDeadLetterQueue(),
      ]);
      return reply.send({
        initialised: !!_gs,
        queueLength,
        activeJobs,
        deadLetterCount: (dlq as unknown[]).length,
        recentJobs: _jobLog.slice(-10).reverse(),
      });
    } catch (e) {
      return reply.send({ initialised: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // GET /gs/dead-letter
  app.get("/gs/dead-letter", async (_req, reply) => {
    if (!_queue) return reply.send({ jobs: [] });
    const dlq = await (_queue as { getDeadLetterQueue(): Promise<unknown[]> }).getDeadLetterQueue();
    return reply.send({ jobs: dlq, count: dlq.length });
  });

  // DELETE /gs/dead-letter — clear DLQ
  app.delete("/gs/dead-letter", async (_req, reply) => {
    if (_queue) await (_queue as { clearDeadLetterQueue(): Promise<void> }).clearDeadLetterQueue();
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
      (_queue as { getQueueLength(): Promise<number> }).getQueueLength(),
      (_queue as { getActiveJobs(): Promise<unknown[]> }).getActiveJobs(),
      (_queue as { getDeadLetterQueue(): Promise<unknown[]> }).getDeadLetterQueue(),
    ]);
    return {
      ...base,
      queueLength: ql,
      activeJobs: (aj as unknown[]).length,
      deadLetterCount: (dlq as unknown[]).length,
    };
  } catch {
    return base;
  }
}
