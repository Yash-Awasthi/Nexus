/**
 * @nexus/agent-automation — Agent automation service with schedule/webhook triggers.
 *
 * Manages automated agent runs triggered by schedules (cron), webhooks,
 * or manual invocation.  Provides full lifecycle: create → trigger → running →
 * complete/failed, with run history, retry logic, and parallel execution control.
 * Inspired by OpenHands' automation-service.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type TriggerType = "schedule" | "webhook" | "manual" | "event";
export type AutomationStatus = "active" | "paused" | "disabled" | "draft";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "retrying";
export type RunExitReason = "success" | "error" | "timeout" | "cancelled";

export interface AutomationTrigger {
  type: TriggerType;
  /** Cron expression for schedule triggers */
  cron?: string;
  /** Webhook path (auto-generated if not specified) */
  webhookPath?: string;
  /** Event name for event triggers */
  eventName?: string;
  /** Timezone for schedule triggers (default: UTC) */
  timezone?: string;
}

export interface AutomationConfig {
  id?: string;
  name: string;
  description?: string;
  /** The agent or workflow to run */
  agentId: string;
  /** Prompt or task description for the agent */
  prompt: string;
  /** Trigger configuration */
  trigger: AutomationTrigger;
  /** Max concurrent runs (default: 1) */
  maxConcurrentRuns?: number;
  /** Retry on failure (default: false) */
  retryOnFailure?: boolean;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Retry delay in ms (default: 60000) */
  retryDelayMs?: number;
  /** Run timeout in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Tags for filtering */
  tags?: string[];
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Initial status (default: "active") */
  status?: AutomationStatus;
}

export interface Automation {
  id: string;
  name: string;
  description?: string;
  agentId: string;
  prompt: string;
  trigger: AutomationTrigger;
  maxConcurrentRuns: number;
  retryOnFailure: boolean;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  tags: string[];
  metadata: Record<string, unknown>;
  status: AutomationStatus;
  /** Number of times triggered */
  triggerCount: number;
  /** Last triggered at */
  lastTriggeredAt?: string;
  /** Last run result */
  lastRunStatus?: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: RunStatus;
  /** The prompt that was used (may differ from automation if overridden) */
  prompt: string;
  /** Agent output/result */
  result?: string;
  /** Error message if failed */
  error?: string;
  /** Exit reason */
  exitReason?: RunExitReason;
  /** Retry attempt number (0 = first run) */
  attempt: number;
  /** Trigger type that initiated this run */
  triggerType: TriggerType;
  /** Duration in ms */
  durationMs?: number;
  /** Token usage */
  tokens?: { input: number; output: number };
  /** Cost in USD */
  costUsd?: number;
  /** Started at */
  startedAt: string;
  /** Completed at */
  completedAt?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

// ─── Automation Store ────────────────────────────────────────────────────────

export interface AutomationStore {
  saveAutomation(automation: Automation): Promise<void>;
  getAutomation(id: string): Promise<Automation | null>;
  listAutomations(filter?: { status?: AutomationStatus; tags?: string[] }): Promise<Automation[]>;
  deleteAutomation(id: string): Promise<boolean>;
  updateAutomation(id: string, updates: Partial<Automation>): Promise<void>;

  saveRun(run: AutomationRun): Promise<void>;
  getRun(id: string): Promise<AutomationRun | null>;
  listRuns(automationId: string, options?: { limit?: number; offset?: number }): Promise<AutomationRun[]>;
  getActiveRuns(automationId: string): Promise<AutomationRun[]>;
}

/**
 * In-memory automation store for development/testing.
 */
export class InMemoryAutomationStore implements AutomationStore {
  private automations = new Map<string, Automation>();
  private runs = new Map<string, AutomationRun>();

  async saveAutomation(automation: Automation): Promise<void> {
    this.automations.set(automation.id, automation);
  }

  async getAutomation(id: string): Promise<Automation | null> {
    return this.automations.get(id) ?? null;
  }

  async listAutomations(filter?: { status?: AutomationStatus; tags?: string[] }): Promise<Automation[]> {
    let results = [...this.automations.values()];
    if (filter?.status) results = results.filter((a) => a.status === filter.status);
    if (filter?.tags) results = results.filter((a) => filter.tags!.some((t) => a.tags.includes(t)));
    return results;
  }

  async deleteAutomation(id: string): Promise<boolean> {
    return this.automations.delete(id);
  }

  async updateAutomation(id: string, updates: Partial<Automation>): Promise<void> {
    const existing = this.automations.get(id);
    if (!existing) throw new Error(`Automation ${id} not found`);
    this.automations.set(id, { ...existing, ...updates, updatedAt: new Date().toISOString() });
  }

  async saveRun(run: AutomationRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async getRun(id: string): Promise<AutomationRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(automationId: string, options?: { limit?: number; offset?: number }): Promise<AutomationRun[]> {
    const runs = [...this.runs.values()]
      .filter((r) => r.automationId === automationId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    return runs.slice(offset, offset + limit);
  }

  async getActiveRuns(automationId: string): Promise<AutomationRun[]> {
    return [...this.runs.values()].filter(
      (r) => r.automationId === automationId && (r.status === "running" || r.status === "pending" || r.status === "retrying"),
    );
  }
}

// ─── Automation Service ──────────────────────────────────────────────────────

export type RunExecutor = (prompt: string, metadata?: Record<string, unknown>) => Promise<{ result: string; tokens?: { input: number; output: number }; costUsd?: number }>;

export interface AutomationServiceConfig {
  store: AutomationStore;
  /** Function that executes an agent run */
  executor: RunExecutor;
  /** Check function to determine if an automation should run (e.g. rate limits) */
  canRun?: (automation: Automation) => Promise<boolean>;
  /** Callback when a run completes */
  onRunComplete?: (run: AutomationRun) => void;
  /** Callback when a run fails */
  onRunFailed?: (run: AutomationRun) => void;
}

/**
 * Full automation lifecycle manager.
 * Handles trigger detection, run execution, retries, and history tracking.
 */
export class AutomationService {
  private config: AutomationServiceConfig;
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: AutomationServiceConfig) {
    this.config = config;
  }

  /**
   * Create a new automation.
   */
  async create(config: AutomationConfig): Promise<Automation> {
    const id = config.id ?? `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const automation: Automation = {
      id,
      name: config.name,
      description: config.description,
      agentId: config.agentId,
      prompt: config.prompt,
      trigger: config.trigger,
      maxConcurrentRuns: config.maxConcurrentRuns ?? 1,
      retryOnFailure: config.retryOnFailure ?? false,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 60_000,
      timeoutMs: config.timeoutMs ?? 300_000,
      tags: config.tags ?? [],
      metadata: config.metadata ?? {},
      status: config.status ?? "active",
      triggerCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.config.store.saveAutomation(automation);

    // Start schedule timer if needed
    if (automation.status === "active" && automation.trigger.type === "schedule" && automation.trigger.cron) {
      this.startSchedule(automation);
    }

    return automation;
  }

  /**
   * Trigger an automation manually (or by webhook/event).
   */
  async trigger(
    automationId: string,
    options?: { promptOverride?: string; triggerType?: TriggerType; metadata?: Record<string, unknown> },
  ): Promise<AutomationRun> {
    const automation = await this.config.store.getAutomation(automationId);
    if (!automation) throw new Error(`Automation ${automationId} not found`);
    if (automation.status === "disabled" || automation.status === "draft") {
      throw new Error(`Automation ${automationId} is ${automation.status}`);
    }

    // Check concurrency limit
    const activeRuns = await this.config.store.getActiveRuns(automationId);
    if (activeRuns.length >= automation.maxConcurrentRuns) {
      throw new Error(`Automation ${automationId} has ${activeRuns.length} active runs (max: ${automation.maxConcurrentRuns})`);
    }

    // Check canRun
    if (this.config.canRun && !(await this.config.canRun(automation))) {
      throw new Error(`Automation ${automationId} cannot run (rate limited or blocked)`);
    }

    // Create run
    const run: AutomationRun = {
      id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      automationId,
      status: "pending",
      prompt: options?.promptOverride ?? automation.prompt,
      attempt: 0,
      triggerType: options?.triggerType ?? "manual",
      startedAt: new Date().toISOString(),
      metadata: options?.metadata,
    };

    await this.config.store.saveRun(run);
    await this.config.store.updateAutomation(automationId, {
      triggerCount: automation.triggerCount + 1,
      lastTriggeredAt: new Date().toISOString(),
    });

    // Execute asynchronously
    this.executeRun(run, automation).catch(() => {});

    return run;
  }

  /**
   * Pause an automation.
   */
  async pause(automationId: string): Promise<void> {
    await this.config.store.updateAutomation(automationId, { status: "paused" });
    this.stopSchedule(automationId);
  }

  /**
   * Resume an automation.
   */
  async resume(automationId: string): Promise<void> {
    const automation = await this.config.store.getAutomation(automationId);
    if (!automation) throw new Error(`Automation ${automationId} not found`);

    await this.config.store.updateAutomation(automationId, { status: "active" });

    if (automation.trigger.type === "schedule" && automation.trigger.cron) {
      this.startSchedule(automation);
    }
  }

  /**
   * Get run history for an automation.
   */
  async getRunHistory(automationId: string, limit?: number): Promise<AutomationRun[]> {
    return this.config.store.listRuns(automationId, { limit });
  }

  /**
   * Get a specific run.
   */
  async getRun(runId: string): Promise<AutomationRun | null> {
    return this.config.store.getRun(runId);
  }

  /**
   * Cancel a running automation run.
   */
  async cancelRun(runId: string): Promise<void> {
    const run = await this.config.store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status !== "running" && run.status !== "pending" && run.status !== "retrying") {
      throw new Error(`Run ${runId} is ${run.status} and cannot be cancelled`);
    }

    run.status = "cancelled";
    run.exitReason = "cancelled";
    run.completedAt = new Date().toISOString();
    await this.config.store.saveRun(run);
  }

  /**
   * Delete an automation and stop its schedule.
   */
  async delete(automationId: string): Promise<void> {
    this.stopSchedule(automationId);
    await this.config.store.deleteAutomation(automationId);
  }

  /**
   * List all automations.
   */
  async list(filter?: { status?: AutomationStatus; tags?: string[] }): Promise<Automation[]> {
    return this.config.store.listAutomations(filter);
  }

  /**
   * Get statistics for an automation.
   */
  async getStats(automationId: string): Promise<{
    totalRuns: number;
    successRate: number;
    avgDurationMs: number;
    totalCostUsd: number;
    lastRunAt?: string;
  }> {
    const runs = await this.config.store.listRuns(automationId, { limit: 1000 });
    const completed = runs.filter((r) => r.status === "completed" || r.status === "failed");
    const successful = runs.filter((r) => r.status === "completed");

    return {
      totalRuns: runs.length,
      successRate: completed.length > 0 ? successful.length / completed.length : 0,
      avgDurationMs: completed.length > 0
        ? completed.reduce((s, r) => s + (r.durationMs ?? 0), 0) / completed.length
        : 0,
      totalCostUsd: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      lastRunAt: runs[0]?.startedAt,
    };
  }

  /**
   * Stop all schedules and clean up.
   */
  shutdown(): void {
    for (const [id] of this.timers) {
      this.stopSchedule(id);
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async executeRun(run: AutomationRun, automation: Automation): Promise<void> {
    run.status = "running";
    await this.config.store.saveRun(run);

    const startTime = Date.now();

    try {
      // Execute with timeout
      const result = await Promise.race([
        this.config.executor(run.prompt, { automationId: automation.id, runId: run.id }),
        this.timeout(automation.timeoutMs, run.id),
      ]);

      const duration = Date.now() - startTime;
      run.status = "completed";
      run.exitReason = "success";
      run.result = result.result;
      run.tokens = result.tokens;
      run.costUsd = result.costUsd;
      run.durationMs = duration;
      run.completedAt = new Date().toISOString();
      await this.config.store.saveRun(run);

      await this.config.store.updateAutomation(automation.id, { lastRunStatus: "completed" });
      this.config.onRunComplete?.(run);
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes("TIMEOUT");

      run.status = "failed";
      run.exitReason = isTimeout ? "timeout" : "error";
      run.error = errorMsg;
      run.durationMs = duration;
      run.completedAt = new Date().toISOString();
      await this.config.store.saveRun(run);

      await this.config.store.updateAutomation(automation.id, { lastRunStatus: "failed" });
      this.config.onRunFailed?.(run);

      // Retry if configured
      if (automation.retryOnFailure && run.attempt < automation.maxRetries) {
        run.attempt++;
        run.status = "retrying";
        run.error = undefined;
        run.exitReason = undefined;
        run.completedAt = undefined;
        await this.config.store.saveRun(run);

        setTimeout(() => {
          this.executeRun(run, automation).catch(() => {});
        }, automation.retryDelayMs);
      }
    }
  }

  private timeout(ms: number, runId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`TIMEOUT: Run ${runId} exceeded ${ms}ms`));
      }, ms);
    });
  }

  private startSchedule(automation: Automation): void {
    this.stopSchedule(automation.id);

    if (!automation.trigger.cron) return;

    // Simple cron parser for common patterns
    const intervalMs = this.parseCronToInterval(automation.trigger.cron);
    if (intervalMs <= 0) return;

    const timer = setInterval(() => {
      if (automation.status !== "active") return;
      this.trigger(automation.id, { triggerType: "schedule" }).catch(() => {});
    }, intervalMs);

    this.timers.set(automation.id, timer);
  }

  private stopSchedule(automationId: string): void {
    const timer = this.timers.get(automationId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(automationId);
    }
  }

  /**
   * Simple cron-to-interval parser.
   * Supports: star-slash-N patterns for minutes and hours.
   */
  private parseCronToInterval(cron: string): number {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return -1;

    const [minute, hour] = parts;

    // Every N minutes: */N * * * *
    if (minute.startsWith("*/")) {
      const n = parseInt(minute.slice(2));
      if (n > 0) return n * 60_000;
    }

    // Every N hours: 0 */N * * *
    if (hour.startsWith("*/")) {
      const n = parseInt(hour.slice(2));
      if (n > 0) return n * 3_600_000;
    }

    // Once per day at HH:MM
    if (minute !== "*" && hour !== "*") {
      return 86_400_000; // 24h
    }

    // Once per hour
    if (minute !== "*" && hour === "*") {
      return 3_600_000;
    }

    return -1;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a simple automation service with in-memory store.
 */
export function createAutomationService(
  executor: RunExecutor,
  options?: Partial<AutomationServiceConfig>,
): AutomationService {
  return new AutomationService({
    store: new InMemoryAutomationStore(),
    executor,
    ...options,
  });
}
