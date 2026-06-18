/**
 * Resource Enforcer — Runtime Capability & Resource Enforcement
 *
 * Extends the capability-policy system with fine-grained runtime controls:
 * - Network egress (allowed hosts, ports, protocols)
 * - Process spawning limits (max processes, allowed binaries)
 * - Environment variable access (allowlist/blocklist)
 * - Execution time budgets (max wall-clock per capability)
 *
 * Integrates with existing FilesystemSandbox, path-boundary, and security-utils.
 */

import { isSafeUrl } from "./security-utils";
import { assertPathDescendsFrom } from "./path-boundary";
import type { IExecutionEnvironment } from "./interfaces/environment.interface";

// ── Types ────────────────────────────────────────────────────────────

/** Granular capability descriptor for resource-level enforcement. */
export type ResourceCapability =
  | "network:egress"       // Outbound HTTP/S connections
  | "process:spawn"        // Spawn child processes
  | "env:read"             // Read environment variables
  | "fs:write"             // Filesystem write (checked by sandbox)
  | "fs:read"              // Filesystem read (checked by sandbox)
  | "browser:interact"     // Browser automation
  | "execution:compute";   // CPU-bound computation

export type NetworkEgressRule = {
  allowedHosts: string[];           // e.g. ["api.example.com"]
  allowedPorts: number[];           // e.g. [443]
  allowedProtocols: ("http" | "https" | "ws" | "wss")[];
  blockPrivateRanges: boolean;      // Block 10.x, 192.168.x, 172.16-31.x
  blockLoopback: boolean;           // Block localhost, 127.0.0.1
};

export type ProcessSpawnRule = {
  maxProcesses: number;             // Max concurrent child processes (0 = disallow)
  allowedBinaries: string[];        // e.g. ["node", "python3", "ffmpeg"]
  allowedEnvpPrefixes: string[];    // Environment var prefixes to pass to children
  sandboxCwd: boolean;              // Force cwd inside sandbox root
};

export type EnvAccessRule = {
  mode: "allowlist" | "blocklist";
  entries: string[];                 // e.g. ["PATH", "HOME", "NODE_ENV"]
};

export type ExecutionTimeBudget = {
  maxWallClockMs: number;            // Max wall-clock per execution scope
  maxCpuMs: number;                  // Max CPU time per execution scope (best-effort)
};

export type ResourceEnforcerConfig = {
  networkEgress?: NetworkEgressRule;
  processSpawn?: ProcessSpawnRule;
  envAccess?: EnvAccessRule;
  timeBudget?: ExecutionTimeBudget;
};

export type ResourceViolation = {
  type: "network_egress" | "process_spawn" | "env_access" | "time_budget";
  detail: string;
  severity: "warn" | "critical";
  blocked: boolean;                  // true = operation prevented, false = just logged
};

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_NETWORK_EGRESS: NetworkEgressRule = {
  allowedHosts: [],
  allowedPorts: [443],
  allowedProtocols: ["https"],
  blockPrivateRanges: true,
  blockLoopback: true,
};

const DEFAULT_PROCESS_SPAWN: ProcessSpawnRule = {
  maxProcesses: 0,                   // No process spawning by default
  allowedBinaries: [],
  allowedEnvpPrefixes: [],
  sandboxCwd: true,
};

const DEFAULT_ENV_ACCESS: EnvAccessRule = {
  mode: "blocklist",
  entries: ["AWS_SECRET", "DB_PASSWORD", "API_KEY", "TOKEN", "SECRET"],
};

const DEFAULT_TIME_BUDGET: ExecutionTimeBudget = {
  maxWallClockMs: 60_000,            // 1 minute
  maxCpuMs: 30_000,                  // 30 seconds
};

// ── Resource Enforcer ────────────────────────────────────────────────

export class ResourceEnforcer {
  private readonly capabilities: Set<ResourceCapability>;
  private readonly networkEgress: NetworkEgressRule;
  private readonly processSpawn: ProcessSpawnRule;
  private readonly envAccess: EnvAccessRule;
  private readonly timeBudget: ExecutionTimeBudget;
  private startTime: number | null = null;
  private processCount = 0;

  constructor(
    capabilities: ResourceCapability[],
    config?: ResourceEnforcerConfig
  ) {
    this.capabilities = new Set(capabilities);
    this.networkEgress = { ...DEFAULT_NETWORK_EGRESS, ...config?.networkEgress };
    this.processSpawn = { ...DEFAULT_PROCESS_SPAWN, ...config?.processSpawn };
    this.envAccess = { ...DEFAULT_ENV_ACCESS, ...config?.envAccess };
    this.timeBudget = { ...DEFAULT_TIME_BUDGET, ...config?.timeBudget };
  }

  /** Start the execution timer for time budget enforcement. */
  startExecutionTimer(): void {
    this.startTime = Date.now();
  }

  /** Get remaining wall-clock time in MS (0 if expired or not started). */
  getRemainingTimeMs(): number {
    if (this.startTime === null) return this.timeBudget.maxWallClockMs;
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.timeBudget.maxWallClockMs - elapsed);
  }

  get isTimeExpired(): boolean {
    return this.getRemainingTimeMs() <= 0;
  }

  // ── Capability Checks ───────────────────────────────────────────

  hasCapability(cap: ResourceCapability): boolean {
    return this.capabilities.has(cap);
  }

  getCapabilities(): ResourceCapability[] {
    return Array.from(this.capabilities);
  }

  // ── Network Egress ──────────────────────────────────────────────

  /**
   * Check if an outbound HTTP/S request is allowed.
   * Uses isSafeUrl() for SSRF protection, then applies egress rules.
   */
  checkNetworkEgress(urlStr: string): ResourceViolation | null {
    if (!this.hasCapability("network:egress")) {
      return {
        type: "network_egress",
        detail: `Network egress not granted — blocked: ${urlStr}`,
        severity: "critical",
        blocked: true,
      };
    }

    // SSRF protection via security-utils
    if (this.networkEgress.blockLoopback || this.networkEgress.blockPrivateRanges) {
      // Use existing isSafeUrl which blocks: localhost, 127.x, 10.x, 192.168.x, 169.254.x
      if (!isSafeUrl(urlStr)) {
        return {
          type: "network_egress",
          detail: `SSRF guard blocked request to disallowed host: ${urlStr}`,
          severity: "critical",
          blocked: true,
        };
      }
    }

    // Host allowlist
    if (this.networkEgress.allowedHosts.length > 0) {
      try {
        const parsed = new URL(urlStr);
        const host = parsed.hostname.toLowerCase();
        if (!this.networkEgress.allowedHosts.some((h) => host === h || host.endsWith("." + h))) {
          return {
            type: "network_egress",
            detail: `Host not in egress allowlist: ${host} (allowed: ${this.networkEgress.allowedHosts.join(", ")})`,
            severity: "critical",
            blocked: true,
          };
        }
      } catch {
        return {
          type: "network_egress",
          detail: `Invalid URL for egress check: ${urlStr}`,
          severity: "critical",
          blocked: true,
        };
      }
    }

    // Port allowlist
    if (this.networkEgress.allowedPorts.length > 0) {
      try {
        const parsed = new URL(urlStr);
        const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
        if (!this.networkEgress.allowedPorts.includes(port)) {
          return {
            type: "network_egress",
            detail: `Port not in egress allowlist: ${port} (allowed: ${this.networkEgress.allowedPorts.join(", ")})`,
            severity: "critical",
            blocked: true,
          };
        }
      } catch {
        // Let through if URL parsing fails (handled upstream)
      }
    }

    return null; // Allowed
  }

  // ── Process Spawning ────────────────────────────────────────────

  /**
   * Check if spawning a child process is allowed.
   */
  checkProcessSpawn(binaryName: string, cwd?: string, sandboxRoot?: string): ResourceViolation | null {
    if (!this.hasCapability("process:spawn")) {
      return {
        type: "process_spawn",
        detail: `Process spawning not granted — blocked: ${binaryName}`,
        severity: "critical",
        blocked: true,
      };
    }

    if (this.processSpawn.maxProcesses > 0 && this.processCount >= this.processSpawn.maxProcesses) {
      return {
        type: "process_spawn",
        detail: `Process count limit reached (${this.processCount}/${this.processSpawn.maxProcesses}) — blocked: ${binaryName}`,
        severity: "critical",
        blocked: true,
      };
    }

    if (this.processSpawn.allowedBinaries.length > 0) {
      const binaryBase = binaryName.split(/[/\\]/).pop() || binaryName;
      if (!this.processSpawn.allowedBinaries.includes(binaryBase)) {
        return {
          type: "process_spawn",
          detail: `Binary not in process allowlist: ${binaryBase} (allowed: ${this.processSpawn.allowedBinaries.join(", ")})`,
          severity: "critical",
          blocked: true,
        };
      }
    }

    // Enforce cwd inside sandbox
    if (this.processSpawn.sandboxCwd) {
      if (!sandboxRoot) {
        return {
          type: "process_spawn",
          detail: `sandboxCwd is enabled but no sandboxRoot provided for cwd enforcement: ${binaryName}`,
          severity: "critical",
          blocked: true,
        };
      }
      if (cwd) {
        try {
          assertPathDescendsFrom(sandboxRoot, cwd);
        } catch {
          return {
            type: "process_spawn",
            detail: `Process cwd is outside sandbox root: ${cwd}`,
            severity: "critical",
            blocked: true,
          };
        }
      }
    }

    return null; // Allowed
  }

  /** Track a spawned process (increments counter). */
  trackSpawnedProcess(): void {
    this.processCount++;
  }

  /** Release a tracked process (decrements counter). */
  releaseProcess(): void {
    if (this.processCount > 0) this.processCount--;
  }

  get currentProcessCount(): number {
    return this.processCount;
  }

  // ── Environment Variable Access ─────────────────────────────────

  /**
   * Check if reading/changing an environment variable is allowed.
   */
  checkEnvAccess(varName: string): ResourceViolation | null {
    if (!this.hasCapability("env:read")) {
      return {
        type: "env_access",
        detail: `Environment variable access not granted — blocked: ${varName}`,
        severity: "critical",
        blocked: true,
      };
    }

    const nameUpper = varName.toUpperCase();
    if (this.envAccess.mode === "blocklist") {
      for (const blocked of this.envAccess.entries) {
        const blockedUpper = blocked.toUpperCase();
        // Use word-boundary matching to avoid false positives like "KEY" in "MONKEY"
        // Env vars use _ as separators, so check exact match, prefix, suffix, or infix with _
        if (
          nameUpper === blockedUpper ||
          nameUpper.startsWith(blockedUpper + "_") ||
          nameUpper.endsWith("_" + blockedUpper) ||
          nameUpper.includes("_" + blockedUpper + "_")
        ) {
          return {
            type: "env_access",
            detail: `Environment variable blocked by blocklist pattern: ${varName}`,
            severity: "warn",
            blocked: false, // Log but don't block (soft enforcement)
          };
        }
      }
    } else if (this.envAccess.mode === "allowlist") {
      const allowed = this.envAccess.entries.some(
        (a) => nameUpper === a.toUpperCase() || nameUpper.startsWith(a.toUpperCase() + "_")
      );
      if (!allowed) {
        return {
          type: "env_access",
          detail: `Environment variable not in allowlist: ${varName}`,
          severity: "warn",
          blocked: false, // Soft enforcement for env access
        };
      }
    }

    return null; // Allowed
  }

  // ── Time Budget ─────────────────────────────────────────────────

  /**
   * Check if the execution has exceeded its time budget.
   */
  checkTimeBudget(): ResourceViolation | null {
    if (this.startTime === null) return null;

    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.timeBudget.maxWallClockMs) {
      return {
        type: "time_budget",
        detail: `Execution exceeded wall-clock budget: ${elapsed}ms (max ${this.timeBudget.maxWallClockMs}ms)`,
        severity: "critical",
        blocked: true,
      };
    }
    return null;
  }

  // ── Factory ─────────────────────────────────────────────────────

  /**
   * Create a ResourceEnforcer from an IExecutionEnvironment.
   * Translates environment capabilities to ResourceCapabilities.
   */
  static fromEnvironment(
    env: IExecutionEnvironment,
    config?: ResourceEnforcerConfig
  ): ResourceEnforcer {
    const caps: ResourceCapability[] = [];

    if (env.capabilities.includes("BROWSER_INTERACT")) {
      caps.push("browser:interact", "network:egress");
    }
    if (env.capabilities.includes("NETWORK_ACCESS")) {
      caps.push("network:egress");
    }
    if (env.capabilities.includes("FILESYSTEM_WRITE")) {
      caps.push("fs:write", "fs:read");
    }
    if (env.capabilities.includes("COMPUTE")) {
      caps.push("execution:compute");
    }

    // Default: add env:read and execution:compute for all environments
    if (!caps.includes("env:read")) caps.push("env:read");
    if (!caps.includes("execution:compute")) caps.push("execution:compute");

    return new ResourceEnforcer(caps, config);
  }
}
