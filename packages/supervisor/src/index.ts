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

export class InMemoryFileIO implements FileIO {
  private store = new Map<string, string>();

  write(path: string, content: string): void { this.store.set(path, content); }
  read(path: string): string | null { return this.store.get(path) ?? null; }
  remove(path: string): boolean { return this.store.delete(path); }
  exists(path: string): boolean { return this.store.has(path); }
}

export class PidFile {
  private io: FileIO;
  private staleTtlMs: number;

  constructor(private path: string, io: FileIO, opts: PidFileOptions = {}) {
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
    try { return JSON.parse(raw) as PidRecord; } catch { return null; }
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

export interface HealthResult {
  status: HealthStatus;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

export type HealthProbe = (signal?: AbortSignal) => Promise<boolean>;

export interface HealthCheckerOptions {
  timeoutMs?: number;   // default: 5_000
  retries?: number;     // default: 1
  retryDelayMs?: number; // default: 500
}

export class HealthChecker {
  private opts: Required<HealthCheckerOptions>;

  constructor(private probe: HealthProbe, opts: HealthCheckerOptions = {}) {
    this.opts = {
      timeoutMs:    opts.timeoutMs    ?? 5_000,
      retries:      opts.retries      ?? 1,
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

export interface ProcessEntry {
  name: string;
  pid?: number;
  state: ProcessState;
  startedAt?: string;
  stoppedAt?: string;
  crashCount: number;
  metadata: Record<string, unknown>;
}

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

export interface ShutdownStep {
  name: string;
  handler: ShutdownHandler;
  /** Max time to wait for this step. Default: 5_000 ms */
  timeoutMs?: number;
}

export interface ShutdownResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class ShutdownCascade {
  private steps: ShutdownStep[] = [];
  private _isShuttingDown = false;

  get isShuttingDown(): boolean { return this._isShuttingDown; }

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
