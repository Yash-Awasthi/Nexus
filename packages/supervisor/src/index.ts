// SPDX-License-Identifier: Apache-2.0
/**
 * supervisor — Process supervision for Nexus background workers.
 *
 * Provides:
 *   • PidFile         — PID file management (write / read / clear / stale-check)
 *   • HealthChecker   — ping-based health probe with timeout + retry
 *   • ProcessRegistry — track named worker processes by id, state, metadata
 *   • ShutdownCascade — ordered, signal-aware graceful shutdown
 */

// ── PidFile ────────────────────────────────────────────────────────────────────

export interface PidFileOptions {
  /** How old (ms) before a pid file is considered stale. Default: 60_000 */
  staleTtlMs?: number;
}

/** Pid record interface definition. */
export interface PidRecord {
  pid: number;
  name: string;
  startedAt: string;
}

/** Injectable file I/O so the class is testable without touching disk. */
export interface FileIO {
  write(path: string, content: string): void;
  read(path: string): string | null;
  remove(path: string): boolean;
  exists(path: string): boolean;
}

/** In memory file io. */
export class InMemoryFileIO implements FileIO {
  private store = new Map<string, string>();

  write(path: string, content: string): void {
    this.store.set(path, content);
  }
  read(path: string): string | null {
    return this.store.get(path) ?? null;
  }
  remove(path: string): boolean {
    return this.store.delete(path);
  }
  exists(path: string): boolean {
    return this.store.has(path);
  }
}

/** Pid file. */
export class PidFile {
  private io: FileIO;
  private staleTtlMs: number;

  constructor(
    private path: string,
    io: FileIO,
    opts: PidFileOptions = {},
  ) {
    this.io = io;
    this.staleTtlMs = opts.staleTtlMs ?? 60_000;
  }

  write(pid: number, name: string): void {
    const record: PidRecord = { pid, name, startedAt: new Date().toISOString() };
    this.io.write(this.path, JSON.stringify(record));
  }

  read(): PidRecord | null {
    const raw = this.io.read(this.path);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PidRecord;
    } catch {
      return null;
    }
  }

  clear(): boolean {
    return this.io.remove(this.path);
  }

  exists(): boolean {
    return this.io.exists(this.path);
  }

  isStale(): boolean {
    const record = this.read();
    if (!record) return false;
    const age = Date.now() - new Date(record.startedAt).getTime();
    return age > this.staleTtlMs;
  }
}

// ── HealthChecker ──────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "unhealthy" | "timeout" | "unknown";

/** Health result interface definition. */
export interface HealthResult {
  status: HealthStatus;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

/** Health probe type alias. */
export type HealthProbe = (signal?: AbortSignal) => Promise<boolean>;

/** Health checker options interface definition. */
export interface HealthCheckerOptions {
  timeoutMs?: number; // default: 5_000
  retries?: number; // default: 1
  retryDelayMs?: number; // default: 500
}

/** Health checker. */
export class HealthChecker {
  private opts: Required<HealthCheckerOptions>;

  constructor(
    private probe: HealthProbe,
    opts: HealthCheckerOptions = {},
  ) {
    this.opts = {
      timeoutMs: opts.timeoutMs ?? 5_000,
      retries: opts.retries ?? 1,
      retryDelayMs: opts.retryDelayMs ?? 500,
    };
  }

  async check(): Promise<HealthResult> {
    const t0 = Date.now();
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (attempt > 0) {
        await sleep(this.opts.retryDelayMs);
      }
      try {
        const ctrl = new AbortController();
        // Race probe against hard timeout so probes that ignore AbortSignal are still cancelled
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            ctrl.abort();
            const err = new Error("probe timed out");
            err.name = "AbortError";
            reject(err);
          }, this.opts.timeoutMs);
        });
        const healthy = await Promise.race([this.probe(ctrl.signal), timeoutPromise]);
        if (healthy) {
          return {
            status: "healthy",
            latencyMs: Date.now() - t0,
            checkedAt: new Date().toISOString(),
          };
        }
        lastError = "probe returned false";
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            status: "timeout",
            latencyMs: Date.now() - t0,
            checkedAt: new Date().toISOString(),
            error: "probe timed out",
          };
        }
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      status: "unhealthy",
      latencyMs: Date.now() - t0,
      checkedAt: new Date().toISOString(),
      error: lastError,
    };
  }
}

// ── ProcessRegistry ────────────────────────────────────────────────────────────

export type ProcessState = "starting" | "running" | "stopping" | "stopped" | "crashed";

/** Process entry interface definition. */
export interface ProcessEntry {
  name: string;
  pid?: number;
  state: ProcessState;
  startedAt?: string;
  stoppedAt?: string;
  crashCount: number;
  metadata: Record<string, unknown>;
}

/** Process registry. */
export class ProcessRegistry {
  private entries = new Map<string, ProcessEntry>();

  register(name: string, metadata: Record<string, unknown> = {}): ProcessEntry {
    const entry: ProcessEntry = {
      name,
      state: "starting",
      crashCount: 0,
      metadata,
    };
    this.entries.set(name, entry);
    return entry;
  }

  markRunning(name: string, pid?: number): void {
    const e = this.requireEntry(name);
    e.state = "running";
    e.startedAt = new Date().toISOString();
    if (pid !== undefined) e.pid = pid;
  }

  markStopping(name: string): void {
    this.requireEntry(name).state = "stopping";
  }

  markStopped(name: string): void {
    const e = this.requireEntry(name);
    e.state = "stopped";
    e.stoppedAt = new Date().toISOString();
    e.pid = undefined;
  }

  markCrashed(name: string): void {
    const e = this.requireEntry(name);
    e.state = "crashed";
    e.stoppedAt = new Date().toISOString();
    e.crashCount++;
    e.pid = undefined;
  }

  get(name: string): ProcessEntry | undefined {
    return this.entries.get(name);
  }

  list(state?: ProcessState): ProcessEntry[] {
    const all = [...this.entries.values()];
    return state ? all.filter((e) => e.state === state) : all;
  }

  deregister(name: string): boolean {
    return this.entries.delete(name);
  }

  count(state?: ProcessState): number {
    return this.list(state).length;
  }

  private requireEntry(name: string): ProcessEntry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Process not registered: ${name}`);
    return e;
  }
}

// ── ShutdownCascade ────────────────────────────────────────────────────────────

export type ShutdownHandler = () => void | Promise<void>;

/** Shutdown step interface definition. */
export interface ShutdownStep {
  name: string;
  handler: ShutdownHandler;
  /** Max time to wait for this step. Default: 5_000 ms */
  timeoutMs?: number;
}

/** Shutdown result interface definition. */
export interface ShutdownResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** Shutdown cascade. */
export class ShutdownCascade {
  private steps: ShutdownStep[] = [];
  private _isShuttingDown = false;

  get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  addStep(step: ShutdownStep): this {
    this.steps.push(step);
    return this;
  }

  /** Run all shutdown steps in registration order. Returns results per step. */
  async run(): Promise<ShutdownResult[]> {
    if (this._isShuttingDown) return [];
    this._isShuttingDown = true;
    const results: ShutdownResult[] = [];

    for (const step of this.steps) {
      const t0 = Date.now();
      const timeoutMs = step.timeoutMs ?? 5_000;
      try {
        await Promise.race([
          Promise.resolve(step.handler()),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("shutdown step timed out")), timeoutMs),
          ),
        ]);
        results.push({ name: step.name, success: true, durationMs: Date.now() - t0 });
      } catch (err) {
        results.push({
          name: step.name,
          success: false,
          durationMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  reset(): void {
    this._isShuttingDown = false;
    this.steps = [];
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── AgentPolicy — omnigent-inspired policy enforcement for agents ──────────────
//
// omnigent (omnigent-ai/omnigent): "Govern your agents. Create policies
// that limit what harnesses can do, sandboxed or un-sandboxed."
// Key insight: separate policy definition from execution; injectable validator
// so policies can be unit-tested without running real agents.

export interface AgentPolicyRule {
  name: string;
  /** Returns null if allowed, or a rejection reason string. */
  check(ctx: AgentPolicyContext): string | null;
}

export interface AgentPolicyContext {
  agentId: string;
  harness: string;
  action: string;
  toolName?: string;
  iteration: number;
  metadata?: Record<string, unknown>;
}

export interface PolicyResult { allowed: boolean; violations: string[] }

/** Agent policy */
export class AgentPolicy {
  private rules: AgentPolicyRule[] = [];

  addRule(rule: AgentPolicyRule): this {
    this.rules.push(rule);
    return this;
  }

  evaluate(ctx: AgentPolicyContext): PolicyResult {
    const violations: string[] = [];
    for (const rule of this.rules) {
      const reason = rule.check(ctx);
      if (reason) violations.push(`[${rule.name}] ${reason}`);
    }
    return { allowed: violations.length === 0, violations };
  }

  /** Pre-built: cap iterations */
  static maxIterations(max: number): AgentPolicyRule {
    return { name: "max-iterations", check: (ctx) => ctx.iteration > max ? `Exceeded max ${max} iterations` : null };
  }

  /** Pre-built: allowlist of tools */
  static allowedTools(tools: string[]): AgentPolicyRule {
    return { name: "allowed-tools", check: (ctx) => ctx.toolName && !tools.includes(ctx.toolName) ? `Tool "${ctx.toolName}" not in allowlist` : null };
  }

  /** Pre-built: blocklist of tools */
  static blockedTools(tools: string[]): AgentPolicyRule {
    return { name: "blocked-tools", check: (ctx) => ctx.toolName && tools.includes(ctx.toolName) ? `Tool "${ctx.toolName}" is blocked` : null };
  }

  /** Pre-built: require sandbox harness */
  static requireSandbox(sandboxHarnesses: string[]): AgentPolicyRule {
    return { name: "require-sandbox", check: (ctx) => !sandboxHarnesses.includes(ctx.harness) ? `Harness "${ctx.harness}" not in sandbox list` : null };
  }
}

// ── AgentHarness — multi-backend agent orchestration (omnigent pattern) ────────

export type HarnessBackend = "claude" | "codex" | "local" | "custom";

export interface HarnessAgentOpts {
  id: string;
  harness: HarnessBackend;
  policy?: AgentPolicy;
  maxIterations?: number;
  metadata?: Record<string, unknown>;
}

export type HarnessRunFn = (agentId: string, prompt: string, iteration: number) => Promise<string>;

export interface AgentRunResult {
  agentId: string;
  harness: HarnessBackend;
  output: string;
  iterations: number;
  policyViolations: string[];
  timestamp: string;
}

/** Agent harness */
export class AgentHarness {
  private opts: HarnessAgentOpts;
  private runFn: HarnessRunFn;

  constructor(opts: HarnessAgentOpts, runFn: HarnessRunFn) {
    this.opts = opts;
    this.runFn = runFn;
  }

  async run(prompt: string): Promise<AgentRunResult> {
    const violations: string[] = [];
    let output = "";
    let iteration = 0;
    const maxIter = this.opts.maxIterations ?? 10;

    while (iteration < maxIter) {
      iteration++;
      const ctx: AgentPolicyContext = { agentId: this.opts.id, harness: this.opts.harness, action: "run", iteration, metadata: this.opts.metadata };
      if (this.opts.policy) {
        const result = this.opts.policy.evaluate(ctx);
        if (!result.allowed) { violations.push(...result.violations); break; }
      }
      try {
        output = await this.runFn(this.opts.id, prompt, iteration);
        break; // single-turn for now; subclass can override for multi-turn
      } catch (e) {
        output = `Error: ${String(e)}`;
        break;
      }
    }

    return { agentId: this.opts.id, harness: this.opts.harness, output, iterations: iteration, policyViolations: violations, timestamp: new Date().toISOString() };
  }
}

// ── SandboxProvisioner — spin up ephemeral sandboxes (omnigent cloud pattern) ──

export type SandboxProvider = "local" | "modal" | "daytona" | "docker";

export interface SandboxSpec {
  provider: SandboxProvider;
  image?: string;
  envVars?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxInstance {
  id: string;
  provider: SandboxProvider;
  status: "starting" | "ready" | "stopped" | "error";
  endpoint?: string;
  createdAt: string;
}

export type ProvisionFn = (spec: SandboxSpec) => Promise<SandboxInstance>;

/** Sandbox provisioner */
export class SandboxProvisioner {
  private providers = new Map<SandboxProvider, ProvisionFn>();
  private instances = new Map<string, SandboxInstance>();

  register(provider: SandboxProvider, fn: ProvisionFn): this {
    this.providers.set(provider, fn);
    return this;
  }

  async provision(spec: SandboxSpec): Promise<SandboxInstance> {
    const fn = this.providers.get(spec.provider);
    if (!fn) {
      // Default local no-op instance
      const inst: SandboxInstance = { id: `local-${Date.now()}`, provider: "local", status: "ready", createdAt: new Date().toISOString() };
      this.instances.set(inst.id, inst);
      return inst;
    }
    const inst = await fn(spec);
    this.instances.set(inst.id, inst);
    return inst;
  }

  async terminate(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (inst) { inst.status = "stopped"; }
  }

  list(): SandboxInstance[] { return [...this.instances.values()]; }
  get(id: string): SandboxInstance | undefined { return this.instances.get(id); }
}

// ── open-multi-agent Task DAG + Scheduling Patterns ──────────────────────────
// Extracted from: open-multi-agent/open-multi-agent
// TypeScript-native multi-agent orchestration: goal → task DAG, 4 scheduling
// strategies, context management, loop detection, stream events.

/** Lifecycle state of a single task in the DAG. */
export type OmaTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"    // waiting on unresolved dependsOn tasks
  | "skipped";

/** A node in the task DAG. dependsOn forms directed edges. */
export interface OmaTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  status: OmaTaskStatus;
  /** Name of the agent assigned to execute this task. */
  assignee?: string;
  /** IDs of tasks that must complete before this one can start. */
  dependsOn?: string[];
  /** ISO-8601 timestamp when the task was last updated. */
  updatedAt?: string;
  /** Arbitrary metadata for rendering or auditing. */
  metadata?: Record<string, unknown>;
}

/**
 * Strategy for assigning pending tasks to available agents.
 * - `round-robin` — distribute evenly by agent index
 * - `least-busy` — assign to the agent with fewest in-progress tasks
 * - `capability-match` — keyword overlap between task description and agent role
 * - `dependency-first` — prioritise tasks on the critical path (most blocked dependents)
 */
export type OmaSchedulingStrategy =
  | "round-robin"
  | "least-busy"
  | "capability-match"
  | "dependency-first";

/**
 * Count how many tasks (transitively) are blocked waiting on `taskId`.
 * Used by `dependency-first` scheduling to rank tasks by criticality.
 * Algorithm: forward BFS over the dependency graph.
 */
export function countBlockedDependents(taskId: string, allTasks: OmaTask[]): number {
  const dependents = new Map<string, string[]>();
  for (const t of allTasks) {
    for (const depId of t.dependsOn ?? []) {
      const list = dependents.get(depId) ?? [];
      list.push(t.id);
      dependents.set(depId, list);
    }
  }
  const visited = new Set<string>();
  const queue: string[] = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const depId of dependents.get(current) ?? []) {
      if (!visited.has(depId)) {
        visited.add(depId);
        queue.push(depId);
      }
    }
  }
  return visited.size;
}

/**
 * Context window management strategy for long agent runs.
 * - `sliding-window` — keep the last N turns
 * - `summarize` — compress history when token count exceeds maxTokens
 * - `compact` — aggressive compaction triggered at maxTokens threshold
 */
export type OmaContextStrategy =
  | { type: "sliding-window"; maxTurns: number }
  | { type: "summarize"; maxTokens: number; summaryModel?: string }
  | { type: "compact"; maxTokens: number };

/** Stream event emitted during an agent run. */
export interface OmaStreamEvent {
  type:
    | "text"
    | "reasoning"
    | "tool_use"
    | "tool_result"
    | "loop_detected"
    | "budget_exceeded"
    | "done"
    | "error";
  data: unknown;
}

/**
 * Loop detection configuration.
 * Fires when the same tool call (name+args) or text output repeats consecutively.
 */
export interface OmaLoopDetectionConfig {
  /** Max consecutive identical outputs before triggering. Default: 3. */
  maxRepetitions?: number;
}

/** Information about a detected loop. */
export interface OmaLoopDetectionInfo {
  kind: "tool_repetition" | "text_repetition";
  /** Number of consecutive identical occurrences observed. */
  repetitions: number;
}

/** Raised when an agent run exceeds its configured token budget. */
export class TokenBudgetExceededError extends Error {
  readonly code = "TOKEN_BUDGET_EXCEEDED" as const;
  constructor(
    readonly agent: string,
    readonly tokensUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded token budget: ${tokensUsed} used (budget: ${budget})`);
    this.name = "TokenBudgetExceededError";
  }
}

/** Raised when an LLM message array violates the content-block contract. */
export class InvalidAgentMessageError extends Error {
  readonly code = "INVALID_MESSAGE" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentMessageError";
  }
}

/** Result returned after an agent completes a run. */
export interface OmaAgentRunResult {
  success: boolean;
  output: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** All tool calls made during the run. */
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output: string }>;
}

/** Assign a set of pending tasks to agents using the specified strategy. */
export function assignTasks(
  pendingTasks: OmaTask[],
  agentNames: string[],
  strategy: OmaSchedulingStrategy,
  activeCounts: Map<string, number> = new Map(),
): Map<string, string> {
  if (agentNames.length === 0 || pendingTasks.length === 0) return new Map();
  const assignments = new Map<string, string>(); // taskId → agentName

  const ranked = [...pendingTasks];
  if (strategy === "dependency-first") {
    ranked.sort((a, b) => countBlockedDependents(b.id, pendingTasks) - countBlockedDependents(a.id, pendingTasks));
  }

  ranked.forEach((task, i) => {
    let agent: string;
    if (strategy === "round-robin") {
      agent = agentNames[i % agentNames.length]!;
    } else if (strategy === "least-busy") {
      agent = agentNames.reduce((best, name) =>
        (activeCounts.get(name) ?? 0) < (activeCounts.get(best) ?? 0) ? name : best,
      );
    } else {
      // capability-match and dependency-first both fall back to round-robin for assignment
      agent = agentNames[i % agentNames.length]!;
    }
    assignments.set(task.id, agent);
  });

  return assignments;
}
