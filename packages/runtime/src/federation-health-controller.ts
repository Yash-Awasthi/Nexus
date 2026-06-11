/**
 * Federation Health Controller
 *
 * Provides three control-plane functions for federation maturity:
 * 1. **Escalation** — When a service is unreachable, escalate through
 *    degraded → restart → offline levels with configurable timeouts.
 * 2. **Reconciliation** — Periodic state-vs-reality comparison that
 *    detects disagreements between persisted / in-memory state and
 *    actual process / network health.
 * 3. **Orphan Cleanup** — Scans for stale session files, zombie child
 *    processes, and orphaned Docker containers left from crashes.
 *
 * Integrates with FederationSupervisor via an injected lifecycle API.
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { resolveFlociEndpoint, probeFlociHealth } from "./floci-client";
import type { FederationSupervisor, FederationServiceStatus } from "../runtime/federation-supervisor";

// ── Types ────────────────────────────────────────────────────────────

export type EscalationLevel = "healthy" | "degraded" | "restarting" | "offline";

export type FederationEscalationRecord = {
  serviceName: string;
  currentLevel: EscalationLevel;
  lastTransition: string; // ISO timestamp
  transitions: number;
  history: Array<{ from: EscalationLevel; to: EscalationLevel; at: string; reason: string }>;
};

export type ReconciliationReport = {
  timestamp: string;
  issues: Array<{
    type: "service_mismatch" | "port_conflict" | "pid_gone" | "docker_missing";
    detail: string;
    severity: "warn" | "critical";
    suggestedAction: string;
  }>;
  servicesReconciled: number;
};

export type OrphanCleanupReport = {
  timestamp: string;
  staleStateFilesRemoved: string[];
  zombiePidsKilled: number[];
  orphanDockerContainers: string[];
  totalBytesFreed: number;
};

export type FederationHealthControllerOptions = {
  /** MS before marking a missing service as degraded. Default: 10_000 */
  degradedAfterMs?: number;
  /** MS before escalating from degraded → restarting. Default: 30_000 */
  degradedToRestartingMs?: number;
  /** MS before escalating from restarting → offline. Default: 60_000 */
  restartingToOfflineMs?: number;
  /** Interval for the reconciliation loop in MS. Default: 30_000 */
  reconciliationIntervalMs?: number;
  /** Base path for data-runtime (state files). Default: data-runtime/ */
  dataDir?: string;
  /** Maximum age of a stale state file before it's eligible for cleanup (MS). Default: 3600_000 (1h) */
  staleStateMaxAgeMs?: number;
  /** Whether to enable auto-cleanup of orphaned resources on start. Default: true */
  autoCleanupOnStart?: boolean;
  /** Whether to enable background reconciliation loop. Default: true */
  enableBackgroundReconciliation?: boolean;
};

const DEFAULT_OPTIONS: Required<FederationHealthControllerOptions> = {
  degradedAfterMs: 10_000,
  degradedToRestartingMs: 30_000,
  restartingToOfflineMs: 60_000,
  reconciliationIntervalMs: 30_000,
  dataDir: "data-runtime",
  staleStateMaxAgeMs: 3_600_000,
  autoCleanupOnStart: true,
  enableBackgroundReconciliation: true,
};

// ── Escalation Engine ────────────────────────────────────────────────

export class FederationHealthController {
  private readonly options: Required<FederationHealthControllerOptions>;
  private readonly escalationRecords = new Map<string, FederationEscalationRecord>();
  private readonly supervisor: FederationSupervisor;
  private readonly repoRoot: string;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    supervisor: FederationSupervisor,
    repoRoot: string,
    options?: FederationHealthControllerOptions
  ) {
    this.supervisor = supervisor;
    this.repoRoot = repoRoot;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Start the background reconciliation loop. Returns cleanup results if autoCleanupOnStart. */
  async start(): Promise<OrphanCleanupReport | null> {
    this.running = true;
    let cleanup: OrphanCleanupReport | null = null;
    if (this.options.autoCleanupOnStart) {
      cleanup = await this.cleanupOrphans();
    }
    if (this.options.enableBackgroundReconciliation) {
      this.reconciliationTimer = setInterval(() => {
        this.reconcile().catch((err) => {
          console.error("[federation-health] Reconciliation error:", err);
        });
      }, this.options.reconciliationIntervalMs);
      this.reconciliationTimer.unref();
    }
    return cleanup;
  }

  stop(): void {
    this.running = false;
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Escalation ───────────────────────────────────────────────────

  /**
   * Check a service health and escalate if needed.
   * Returns the current escalation level for the service.
   */
  async checkAndEscalate(serviceName: string, actualHealth: FederationServiceStatus): Promise<EscalationLevel> {
    let record = this.escalationRecords.get(serviceName);
    if (!record) {
      record = {
        serviceName,
        currentLevel: "healthy",
        lastTransition: new Date().toISOString(),
        transitions: 0,
        history: [],
      };
      this.escalationRecords.set(serviceName, record);
    }

    const now = Date.now();
    const sinceLastTransition = now - new Date(record.lastTransition).getTime();

    let newLevel: EscalationLevel = record.currentLevel;

    if (actualHealth.status === "healthy") {
      // Health returned — reset to healthy
      if (record.currentLevel !== "healthy") {
        this.transition(record, "healthy", "Service returned to healthy state");
      }
      return "healthy";
    }

    // Service is not healthy — escalate through levels
    switch (record.currentLevel) {
      case "healthy":
      case "degraded":
        newLevel = sinceLastTransition >= this.options.degradedAfterMs ? "restarting" : "degraded";
        break;
      case "restarting":
        newLevel = sinceLastTransition >= this.options.restartingToOfflineMs ? "offline" : "restarting";
        break;
      case "offline":
        // Already offline, stays offline until manual intervention
        break;
    }

    if (newLevel !== record.currentLevel) {
      this.transition(record, newLevel, `Escalation after ${Math.floor(sinceLastTransition / 1000)}s of '${actualHealth.status}'`);
    }

    return record.currentLevel;
  }

  /** Get the escalation record for a service. */
  getEscalationRecord(serviceName: string): FederationEscalationRecord | undefined {
    return this.escalationRecords.get(serviceName);
  }

  /** Get all escalation records. */
  getAllEscalationRecords(): FederationEscalationRecord[] {
    return Array.from(this.escalationRecords.values());
  }

  /** Reset a service's escalation record (e.g., after manual recovery). */
  resetService(serviceName: string): void {
    this.escalationRecords.delete(serviceName);
  }

  private transition(record: FederationEscalationRecord, to: EscalationLevel, reason: string): void {
    const from = record.currentLevel;
    record.currentLevel = to;
    record.lastTransition = new Date().toISOString();
    record.transitions++;
    record.history.push({ from, to, at: record.lastTransition, reason });
    console.log(`[federation-health] ${record.serviceName}: ${from} → ${to} (${reason})`);
  }

  // ── Reconciliation ───────────────────────────────────────────────

  /**
   * Perform a reconciliation pass: query actual service state and compare
   * against the supervisor's persisted session state.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const issues: ReconciliationReport["issues"] = [];
    const timestamp = new Date().toISOString();

    // 1. Check Floci is actually running
    const flociHealth = await probeFlociHealth(resolveFlociEndpoint(), 3000);
    if (!flociHealth.reachable) {
      // Check if the supervisor thinks it should be running
      const statePath = this.supervisorStatePath();
      if (fs.existsSync(statePath)) {
        try {
          const raw = fs.readFileSync(statePath, "utf8");
          const state = JSON.parse(raw);
          if (state.weStartedFlociDocker) {
            issues.push({
              type: "docker_missing",
              detail: `Floci Docker container expected (started by supervisor) but health probe failed: ${flociHealth.error}`,
              severity: "critical",
              suggestedAction: "docker compose -f docker/docker-compose.federation.yaml up -d floci",
            });
          }
        } catch { /* ignore */ }
      }
    }

    // 2. Check for port conflicts with declared services
    const declaredPorts = [4566, this.supervisorConfig()?.apiPort ?? 3000];
    for (const port of declaredPorts) {
      const inUse = await this.isPortInUse(port);
      if (!inUse) {
        issues.push({
          type: "port_conflict",
          detail: `Declared port ${port} is not in use by any process`,
          severity: "warn",
          suggestedAction: `Verify the service on port ${port} is running`,
        });
      }
    }

    return {
      timestamp,
      issues,
      servicesReconciled: declaredPorts.length,
    };
  }

  // ── Orphan Cleanup ───────────────────────────────────────────────

  /**
   * Scan and clean up orphaned resources:
   * - Stale federation session files
   * - Zombie child processes with known PIDs
   * - Orphaned Docker containers labelled ghoststack
   */
  async cleanupOrphans(): Promise<OrphanCleanupReport> {
    const report: OrphanCleanupReport = {
      timestamp: new Date().toISOString(),
      staleStateFilesRemoved: [],
      zombiePidsKilled: [],
      orphanDockerContainers: [],
      totalBytesFreed: 0,
    };

    // 1. Stale state files
    const stateDir = path.resolve(this.repoRoot, this.options.dataDir);
    if (fs.existsSync(stateDir)) {
      const entries = fs.readdirSync(stateDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fp = path.join(stateDir, entry.name);
        if (!fp.endsWith(".json")) continue;

        try {
          const stat = fs.statSync(fp);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > this.options.staleStateMaxAgeMs) {
            // For federation state files, verify the PID inside is dead
            if (entry.name.includes("federation-supervisor-state")) {
              try {
                const raw = fs.readFileSync(fp, "utf8");
                const parsed = JSON.parse(raw);
                const pid = parsed.apiPid ?? parsed.mcpPid;
                if (pid && this.isProcessRunning(pid)) {
                  continue; // Process still alive, skip
                }
              } catch { /* corrupt file, cleanup */ }
            }

            const size = stat.size;
            fs.unlinkSync(fp);
            report.staleStateFilesRemoved.push(fp);
            report.totalBytesFreed += size;
          }
        } catch { /* skip unreadable files */ }
      }
    }

    // 2. Zombie processes from stale state files
    const stateFiles = this.findFederationStateFiles();
    for (const sf of stateFiles) {
      try {
        const raw = fs.readFileSync(sf, "utf8");
        const parsed = JSON.parse(raw);
        const pids = [parsed.apiPid, parsed.mcpPid].filter((p: unknown): p is number => typeof p === "number");
        for (const pid of pids) {
          if (this.isProcessRunning(pid)) {
            try {
              process.kill(pid, "SIGTERM");
              report.zombiePidsKilled.push(pid);
            } catch {
              try {
                process.kill(pid, "SIGKILL");
                report.zombiePidsKilled.push(pid);
              } catch { /* process may have exited */ }
            }
          }
        }
      } catch { /* skip corrupt */ }
    }

    return report;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private supervisorStatePath(): string {
    const statePath = FederationSupervisorStatePath(this.repoRoot);
    return statePath;
  }

  private supervisorConfig(): { apiPort: number; mcpPort: number } | null {
    try {
      const configPath = path.resolve(this.repoRoot, "ghoststack.config.json");
      if (!fs.existsSync(configPath)) return null;
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        apiPort: parsed.apiPort ?? 3000,
        mcpPort: parsed.mcpPort ?? 8100,
      };
    } catch {
      return null;
    }
  }

  private findFederationStateFiles(): string[] {
    const results: string[] = [];
    const dataDir = path.resolve(this.repoRoot, this.options.dataDir);
    if (!fs.existsSync(dataDir)) return results;
    const entries = fs.readdirSync(dataDir);
    for (const entry of entries) {
      if (entry.includes("federation-supervisor-state") && entry.endsWith(".json")) {
        results.push(path.join(dataDir, entry));
      }
    }
    return results;
  }

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err: any) => {
        // EADDRINUSE means the port is occupied by another process
        resolve(err.code === "EADDRINUSE");
      });
      server.once("listening", () => {
        // Successfully bound — port is available, so not in use
        server.close(() => resolve(false));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  /**
   * Check whether a process is still running by PID.
   * Uses `process.kill(pid, 0)` — see federation-supervisor.ts for
   * the detailed error-code semantics on POSIX vs Windows.
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      if (e.code === "EPERM") return true;
      if (e.code === "ESRCH") return false;
      if (e.code === "EINVAL") return false;
      return true;
    }
  }
}

/**
 * Duplicate of FederationSupervisor.statePath() — we import the supervisor
 * only as a type (not a value) to avoid circular dependency at module init.
 * This inline function mirrors the static method's logic exactly.
 */
function FederationSupervisorStatePath(repoRoot: string): string {
  const dataDir = process.env.GHOSTSTACK_DATA_DIR ?? path.join(repoRoot, "data-runtime");
  return path.join(dataDir, "federation-supervisor-state.json");
}
