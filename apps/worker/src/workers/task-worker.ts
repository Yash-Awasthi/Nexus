// SPDX-License-Identifier: Apache-2.0
/**
 * TaskWorker — BullMQ Worker that drains the nexus-high / nexus-medium / nexus-low queues.
 *
 * Job routing:
 *   "ingest:event"        → handleIngestJob
 *   "council.deliberate"  → handleCouncilJob
 *   "wiki:reconcile"      → handleWikiReconcileJob
 *   "corpus:build"        → handleCorpusBuildJob
 *   "obs:generate"        → handleObsGenerateJob
 *   "feeds:refresh"       → handleFeedsRefreshJob
 *   "feeds:refresh:rss"   → handleFeedsRefreshRssJob
 *   "search:reindex"      → handleSearchReindexJob
 *   (unknown)             → log + complete (no-op)
 *
 * Concurrency:
 *   - nexus-high:   4 concurrent workers
 *   - nexus-medium: 8 concurrent workers
 *   - nexus-low:    2 concurrent workers
 *
 * Error handling:
 *   - Jobs fail after maxRetries (configured per-job in BullMQ opts)
 *   - Failed jobs land in the BullMQ failed set (accessible via queue.getFailed())
 *   - The worker emits structured log lines on success / failure for telemetry
 */

import { db } from "@nexus/db";
import { runtimeTasks } from "@nexus/db/schema";
import { type ConnectionOptions, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";

import { handleAgentRunJob, type AgentRunPayload } from "../handlers/agent-handler.js";
import {
  handleWikiReconcileJob,
  handleCorpusBuildJob,
  handleObsGenerateJob,
  handleFeedsRefreshJob,
  handleFeedsRefreshRssJob,
  handleSearchReindexJob,
  type WikiReconcilePayload,
  type CorpusBuildPayload,
  type ObsGeneratePayload,
  type FeedsRefreshPayload,
  type FeedsRefreshRssPayload,
  type SearchReindexPayload,
} from "../handlers/async-handlers.js";
import { handleCouncilJob, type CouncilJobPayload } from "../handlers/council-handler.js";
import { handleDriveExecJob, type DriveExecPayload } from "../handlers/drive-handler.js";
import { handleIngestJob, type IngestJobPayload } from "../handlers/ingest-handler.js";
import {
  handleOrchestrationJob,
  type OrchestrationJobPayload,
} from "../handlers/orchestration-handler.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const QUEUE_HIGH = "nexus-high";
const QUEUE_MEDIUM = "nexus-medium";
const QUEUE_LOW = "nexus-low";

// ── Job dispatcher ────────────────────────────────────────────────────────────

async function processJob(job: Job): Promise<unknown> {
  const { name, data } = job;

  // Update runtime_tasks row if taskId is present in payload
  const taskId: string | undefined = (data as Record<string, unknown>).taskId as string | undefined;
  if (taskId) {
    await db
      .update(runtimeTasks)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(runtimeTasks.id, taskId));
  }

  let result: unknown;

  switch (name) {
    case "ingest:event":
      result = await handleIngestJob(data as IngestJobPayload);
      break;

    // ── Native coding-agent loop ──────────────────────────────────────────────
    case "agent.run":
      result = await handleAgentRunJob(data as AgentRunPayload);
      break;

    // ── Drive sandbox execution ───────────────────────────────────────────────
    case "drive.exec":
      result = await handleDriveExecJob(data as DriveExecPayload);
      break;

    case "council.deliberate":
    case "council.evaluate":
      result = await handleCouncilJob(data as CouncilJobPayload);
      break;

    // ── Parallel multi-agent worktree fan-out ─────────────────────────────────
    case "orchestration.run":
      result = await handleOrchestrationJob(data as OrchestrationJobPayload);
      break;

    // ── Async package backbone ────────────────────────────────────────────────
    case "wiki:reconcile":
      result = await handleWikiReconcileJob(data as WikiReconcilePayload);
      break;

    case "corpus:build":
      result = await handleCorpusBuildJob(data as CorpusBuildPayload);
      break;

    case "obs:generate":
      result = await handleObsGenerateJob(data as ObsGeneratePayload);
      break;

    case "feeds:refresh":
      result = await handleFeedsRefreshJob(data as FeedsRefreshPayload);
      break;

    case "feeds:refresh:rss":
      result = await handleFeedsRefreshRssJob(data as FeedsRefreshRssPayload);
      break;

    case "search:reindex":
      result = await handleSearchReindexJob(data as SearchReindexPayload);
      break;

    default:
      console.warn(`[task-worker] Unknown job name: ${name} — completing no-op`);
      result = { noop: true, jobName: name };
  }

  // Mark runtime task completed if linked
  if (taskId) {
    await db
      .update(runtimeTasks)
      .set({ status: "completed", completedAt: new Date(), result })
      .where(eq(runtimeTasks.id, taskId));
  }

  return result;
}

// ── Worker factory ────────────────────────────────────────────────────────────

/** Parse a positive-integer env var, falling back to a default. */
function envConcurrency(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createTaskWorkers(connection: ConnectionOptions): Worker[] {
  const workerOpts = { connection, removeOnComplete: { count: 100 }, removeOnFail: { count: 50 } };

  // Concurrency per queue is tunable per deployment (scale up on bigger nodes,
  // down on constrained ones). Defaults preserve the previous 4 / 8 / 2 split.
  const highWorker = new Worker(QUEUE_HIGH, processJob, {
    ...workerOpts,
    concurrency: envConcurrency("WORKER_CONCURRENCY_HIGH", 4),
  });
  const mediumWorker = new Worker(QUEUE_MEDIUM, processJob, {
    ...workerOpts,
    concurrency: envConcurrency("WORKER_CONCURRENCY_MEDIUM", 8),
  });
  const lowWorker = new Worker(QUEUE_LOW, processJob, {
    ...workerOpts,
    concurrency: envConcurrency("WORKER_CONCURRENCY_LOW", 2),
  });

  const workers = [highWorker, mediumWorker, lowWorker];

  for (const worker of workers) {
    worker.on("completed", (job: Job, result: unknown) => {
      console.log(
        JSON.stringify({
          level: "info",
          event: "job.completed",
          jobId: job.id,
          name: job.name,
          result,
        }),
      );
    });

    worker.on("failed", (job: Job | undefined, err: Error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "job.failed",
          jobId: job?.id,
          name: job?.name,
          error: err.message,
          attemptsMade: job?.attemptsMade,
        }),
      );

      // Mark linked runtime task as failed
      const taskId = (job?.data as Record<string, unknown>)?.taskId as string | undefined;
      if (taskId) {
        db.update(runtimeTasks)
          .set({ status: "failed", completedAt: new Date(), error: err.message })
          .where(eq(runtimeTasks.id, taskId))
          .catch(console.error);
      }
    });
  }

  return workers;
}
