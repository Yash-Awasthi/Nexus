// SPDX-License-Identifier: Apache-2.0
import type { IEventBus } from "./event-bus.js";
import type {
  ITaskExecutor,
  IExecutionAdapter,
  IExecutionContext,
} from "./interfaces/execution.interface.js";
import type { ILogger } from "./interfaces/logger.interface.js";
import type { IMetricsCollector, ITraceRecorder } from "./interfaces/observability.interface.js";
import type { IRuntimePersistence } from "./interfaces/persistence.interface.js";
import type { IQueueBackend } from "./interfaces/queue.interface.js";

export class TaskExecutor implements ITaskExecutor {
  private queue: IQueueBackend;
  private bus: IEventBus;
  private persistence: IRuntimePersistence;
  private logger: ILogger;
  private adapters: IExecutionAdapter[];
  private metrics?: IMetricsCollector;
  private tracer?: ITraceRecorder;
  /**
   * Backoff delay (ms) set by executeNext when a retry is scheduled.
   * Consumed and reset by runLoop so that executeNext stays non-blocking.
   */
  private _pendingRetryDelayMs = 0;

  constructor(
    queue: IQueueBackend,
    bus: IEventBus,
    persistence: IRuntimePersistence,
    logger: ILogger,
    adapters: IExecutionAdapter[],
    metrics?: IMetricsCollector,
    tracer?: ITraceRecorder,
  ) {
    this.queue = queue;
    this.bus = bus;
    this.persistence = persistence;
    this.logger = logger;
    this.adapters = adapters;
    this.metrics = metrics;
    this.tracer = tracer;
  }

  async start(): Promise<void> {
    this.logger.info("Task Executor core runtime started.");
  }

  async executeNext(): Promise<boolean> {
    const job = await this.queue.pop();
    if (!job) return false;

    // Track active queue size reduction
    const length = await this.queue.getQueueLength();
    this.metrics?.recordGauge("queue.size", length);

    const taskType = job.payload?.type || "floci";
    const adapter = this.adapters.find((a) => a.canExecute(taskType));

    if (!adapter) {
      this.logger.error(`No executable adapter found for task type: ${taskType}`);
      await this.queue.moveToDeadLetter(job, `Unsupported task type: ${taskType}`);
      this.metrics?.increment("task.failed");
      this.metrics?.increment("task.dead_letter");
      return false;
    }

    const context: IExecutionContext = {
      taskId: job.id,
      startTime: new Date(),
      attempt: job.retries + 1,
      environment: {},
      logger: this.logger,
    };

    this.metrics?.increment("task.executed");
    const traceSpan = this.tracer?.startSpan("task.execute", undefined, {
      taskId: job.id,
      attempt: context.attempt,
    });

    await this.bus.publish("execution_started", { taskId: job.id, timestamp: new Date() });

    try {
      const startTimeMs = Date.now();
      const result = await adapter.execute(job.payload, context);
      const durationMs = Date.now() - startTimeMs;

      this.metrics?.recordTiming("task.latency", durationMs);
      if (taskType === "floci" && result && typeof result === "object") {
        const r = result;
        if (typeof r.flociRequestMs === "number") {
          this.metrics?.recordTiming("floci.request_ms", r.flociRequestMs);
        }
        if (r.mocked === true) {
          this.metrics?.increment("floci.mocked");
        } else if (r.mocked === false) {
          this.metrics?.increment("floci.live");
        }
      }
      this.metrics?.increment("task.success");

      await this.persistence.saveState(job.id, {
        status: "success",
        result,
        timestamp: new Date(),
      });

      await this.bus.publish("execution_succeeded", {
        taskId: job.id,
        result,
        durationMs,
        timestamp: new Date(),
      });

      if (traceSpan) {
        this.tracer?.endSpan(traceSpan.spanId, { status: "success", durationMs });
      }

      return true;
    } catch (err: any) {
      const errorMessage = err?.message || String(err);
      this.logger.error(`Task ${job.id} execution failed: ${errorMessage}`);

      this.metrics?.increment("task.failed");

      await this.persistence.saveState(job.id, {
        status: "failed",
        error: errorMessage,
        timestamp: new Date(),
      });

      await this.bus.publish("execution_failed", {
        taskId: job.id,
        error: errorMessage,
        attempts: context.attempt,
        timestamp: new Date(),
      });

      if (traceSpan) {
        this.tracer?.endSpan(traceSpan.spanId, { status: "failed", error: errorMessage });
      }

      // Handle retry scheduling
      job.retries += 1;
      if (job.retries >= job.maxRetries) {
        this.metrics?.increment("task.dead_letter");
      } else {
        this.metrics?.increment("task.retry");
        // Compute exponential backoff: 500ms * 2^(retries-1), capped at 30 s.
        // Stored for runLoop to consume — executeNext itself stays non-blocking.
        this._pendingRetryDelayMs = Math.min(500 * Math.pow(2, job.retries - 1), 30_000);
        this.logger.info(
          `Task ${job.id} scheduled for retry ${job.retries}/${job.maxRetries} in ${this._pendingRetryDelayMs}ms`,
        );
      }
      await this.queue.push(job); // will trigger dead letter inside push if exhausted

      return false;
    }
  }

  /**
   * Continuously drains the queue until it is empty or `maxIterations` is reached.
   * Applies exponential backoff delays between retries (scheduled by executeNext).
   * Returns the total number of tasks processed successfully.
   *
   * @param maxIterations - Safety ceiling (default: 10 000). Pass Infinity to run until queue drains.
   * @param idleDelayMs   - Idle poll interval when the queue returns nothing (default: 100ms).
   */
  async runLoop(maxIterations = 10_000, idleDelayMs = 100): Promise<number> {
    let successCount = 0;
    let iterations = 0;
    let consecutiveEmpty = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;

    this.logger.info("TaskExecutor runLoop started", { maxIterations, idleDelayMs });

    while (iterations < maxIterations) {
      this._pendingRetryDelayMs = 0;
      const processed = await this.executeNext();
      iterations++;

      if (processed) {
        successCount++;
        consecutiveEmpty = 0;
      } else {
        // Apply any backoff delay set by executeNext for a scheduled retry
        if (this._pendingRetryDelayMs > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this._pendingRetryDelayMs).unref(),
          );
          this._pendingRetryDelayMs = 0;
          consecutiveEmpty = 0;
          continue;
        }

        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          // Queue appears drained — confirm with a length check
          const remaining = await this.queue.getQueueLength();
          if (remaining === 0) {
            this.logger.info("TaskExecutor runLoop: queue drained, exiting", {
              iterations,
              successCount,
            });
            break;
          }
          consecutiveEmpty = 0;
        }
        // Brief idle wait before next poll
        await new Promise<void>((resolve) => setTimeout(resolve, idleDelayMs).unref());
      }
    }

    this.logger.info("TaskExecutor runLoop completed", { iterations, successCount });
    return successCount;
  }
}
