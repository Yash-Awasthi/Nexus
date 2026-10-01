// SPDX-License-Identifier: Apache-2.0
/**
 * TaskWorker — BullMQ Worker that drains the nexus-high / nexus-medium / nexus-low queues.
 *
 * Job routing:
 *   "ingest:event"        → handleIngestJob
 *   "browser.task"        → handleBrowserTaskJob
 *   "drive.reclaim"       → handleDriveReclaimJob (repeatable, daily)
 *   "drive.sweep"         → handleDriveSweepJob (repeatable, hourly)
 *   "drive.backup"        → handleDriveBackupJob (repeatable, daily)
 *   "council.deliberate"  → handleCouncilJob
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
import { startTracing } from "@nexus/telemetry";
import { SpanStatusCode } from "@opentelemetry/api";
import { type ConnectionOptions, Worker, type Job } from "bullmq";
import { and, eq, ne } from "drizzle-orm";

import { handleAgentRunJob, type AgentRunPayload } from "../handlers/agent-handler.js";
import { handleBrowserTaskJob, type BrowserTaskPayload } from "../handlers/browser-task.js";
import { handleCouncilJob, type CouncilJobPayload } from "../handlers/council-handler.js";
import {
  handleDriveBackupJob,
  handleDriveReclaimJob,
  handleDriveSweepJob,
  type DriveBackupPayload,
  type DriveReclaimPayload,
  type DriveSweepPayload,
} from "../handlers/drive-lifecycle.js";
import { handleIngestJob, type IngestJobPayload } from "../handlers/ingest-handler.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const QUEUE_HIGH = "nexus-high";
const QUEUE_MEDIUM = "nexus-medium";
const QUEUE_LOW = "nexus-low";

// ── Job dispatcher ────────────────────────────────────────────────────────────

/** Each job runs in its own span when tracing is on (OTEL_EXPORTER_OTLP_ENDPOINT). */
async function processJob(job: Job): Promise<unknown> {
  const tracer = startTracing("nexus-worker");
  if (!tracer) return runJob(job);
  return tracer.startActiveSpan(
    `job ${job.name}`,
    { attributes: { "messaging.system": "bullmq", "messaging.message.id": job.id ?? "" } },
    async (span) => {
      try {
        return await runJob(job);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

async function runJob(job: Job): Promise<unknown> {
  const { name, data } = job;

  // Update runtime_tasks row if taskId is present in payload
  const taskId: string | undefined = (data as Record<string, unknown>).taskId as string | undefined;
  if (taskId) {
    const [started] = await db
      .update(runtimeTasks)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(runtimeTasks.id, taskId), ne(runtimeTasks.status, "cancelled")))
      .returning({ id: runtimeTasks.id });
    const [cancelled] = started
      ? []
      : await db
          .select({ id: runtimeTasks.id })
          .from(runtimeTasks)
          .where(and(eq(runtimeTasks.id, taskId), eq(runtimeTasks.status, "cancelled")));
    if (cancelled) return { cancelled: true };
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

    // ── Browser agent task loop (§15.4) ───────────────────────────────────────
    case "browser.task":
      result = await handleBrowserTaskJob(data as BrowserTaskPayload);
      break;

    // ── Drive lifecycle (repeatable) ──────────────────────────────────────────
    case "drive.reclaim":
      result = await handleDriveReclaimJob(data as DriveReclaimPayload);
      break;

    case "drive.sweep":
      result = await handleDriveSweepJob(data as DriveSweepPayload);
      break;

    case "drive.backup":
      result = await handleDriveBackupJob(data as DriveBackupPayload);
      break;

    case "council.deliberate":
      result = await handleCouncilJob(data as CouncilJobPayload);
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
