/**
 * ResourceEnforcer Tests
 *
 * Covers: network egress, process spawning, env access, time budget,
 * capability checks, fromEnvironment factory, and integration scenarios.
 */

import { ResourceEnforcer } from "../orchestration/resource-enforcer";
import type { IExecutionEnvironment } from "../orchestration/interfaces/environment.interface";

// ── Helpers ──────────────────────────────────────────────────────────

function createTestEnv(name: string, capabilities: string[]): IExecutionEnvironment {
  return {
    name,
    capabilities,
    telemetry: {
      browserSessionsActive: 0,
      totalBytesFetched: 0,
      totalWritesCount: 0,
      totalBytesWritten: 0,
      navigationHistory: [],
      recordNavigation: jest.fn(),
      recordFetch: jest.fn(),
      recordWrite: jest.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ResourceEnforcer", () => {
  // ── Capabilities ────────────────────────────────────────────────

  describe("capabilities", () => {
    it("has no capabilities by default when created empty", () => {
      const enforcer = new ResourceEnforcer([]);
      expect(enforcer.getCapabilities()).toEqual([]);
      expect(enforcer.hasCapability("network:egress")).toBe(false);
      expect(enforcer.hasCapability("process:spawn")).toBe(false);
    });

    it("reports capabilities that were granted", () => {
      const enforcer = new ResourceEnforcer(["network:egress", "fs:write"]);
      expect(enforcer.hasCapability("network:egress")).toBe(true);
      expect(enforcer.hasCapability("fs:write")).toBe(true);
      expect(enforcer.hasCapability("process:spawn")).toBe(false);
    });
  });

  // ── Network Egress ──────────────────────────────────────────────

  describe("network egress", () => {
    it("blocks all egress when capability not granted", () => {
      const enforcer = new ResourceEnforcer([], {
        networkEgress: { allowedHosts: [], allowedPorts: [443], allowedProtocols: ["https"], blockPrivateRanges: false, blockLoopback: false },
      });
      const violation = enforcer.checkNetworkEgress("https://example.com");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("network_egress");
      expect(violation!.blocked).toBe(true);
    });

    it("allows egress to allowed hosts", () => {
      const enforcer = new ResourceEnforcer(["network:egress"], {
        networkEgress: {
          allowedHosts: ["api.example.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          blockPrivateRanges: true,
          blockLoopback: true,
        },
      });
      expect(enforcer.checkNetworkEgress("https://api.example.com/v1/data")).toBeNull();
    });

    it("blocks egress to disallowed hosts", () => {
      const enforcer = new ResourceEnforcer(["network:egress"], {
        networkEgress: {
          allowedHosts: ["api.example.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          blockPrivateRanges: true,
          blockLoopback: true,
        },
      });
      const violation = enforcer.checkNetworkEgress("https://evil.com/exfil");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("network_egress");
      expect(violation!.blocked).toBe(true);
    });

    it("blocks loopback addresses with blockLoopback", () => {
      const enforcer = new ResourceEnforcer(["network:egress"], {
        networkEgress: {
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
          blockPrivateRanges: true,
          blockLoopback: true,
        },
      });
      expect(enforcer.checkNetworkEgress("http://127.0.0.1:3000")).not.toBeNull();
      expect(enforcer.checkNetworkEgress("http://localhost:4566")).not.toBeNull();
    });

    it("blocks private IP ranges with blockPrivateRanges", () => {
      const enforcer = new ResourceEnforcer(["network:egress"], {
        networkEgress: {
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
          blockPrivateRanges: true,
          blockLoopback: true,
        },
      });
      expect(enforcer.checkNetworkEgress("http://10.0.0.1")).not.toBeNull();
      expect(enforcer.checkNetworkEgress("http://192.168.1.1")).not.toBeNull();
    });

    it("blocks disallowed ports", () => {
      const enforcer = new ResourceEnforcer(["network:egress"], {
        networkEgress: {
          allowedHosts: ["example.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          blockPrivateRanges: true,
          blockLoopback: true,
        },
      });
      const violation = enforcer.checkNetworkEgress("http://example.com:8080");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("network_egress");
    });

    it("allows any host when allowlist is empty", () => {
      const enforcer = new ResourceEnforcer(["network:egress"], {
        networkEgress: {
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
          blockPrivateRanges: false,
          blockLoopback: false,
        },
      });
      // With allowlist empty AND private ranges disabled, should allow
      expect(enforcer.checkNetworkEgress("https://example.com/data")).toBeNull();
    });
  });

  // ── Process Spawning ────────────────────────────────────────────

  describe("process spawning", () => {
    it("blocks all process spawning when capability not granted", () => {
      const enforcer = new ResourceEnforcer([]);
      const violation = enforcer.checkProcessSpawn("node");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("process_spawn");
      expect(violation!.blocked).toBe(true);
    });

    it("allows process spawning for allowed binaries", () => {
      const enforcer = new ResourceEnforcer(["process:spawn"], {
        processSpawn: {
          maxProcesses: 5,
          allowedBinaries: ["node", "python3"],
          allowedEnvpPrefixes: [],
          sandboxCwd: false,
        },
      });
      expect(enforcer.checkProcessSpawn("node")).toBeNull();
      expect(enforcer.checkProcessSpawn("python3")).toBeNull();
    });

    it("blocks process spawning for disallowed binaries", () => {
      const enforcer = new ResourceEnforcer(["process:spawn"], {
        processSpawn: {
          maxProcesses: 5,
          allowedBinaries: ["node"],
          allowedEnvpPrefixes: [],
          sandboxCwd: false,
        },
      });
      expect(enforcer.checkProcessSpawn("rm")).not.toBeNull();
      expect(enforcer.checkProcessSpawn("bash")).not.toBeNull();
    });

    it("enforces max process count", () => {
      const enforcer = new ResourceEnforcer(["process:spawn"], {
        processSpawn: {
          maxProcesses: 2,
          allowedBinaries: ["node", "python3"],
          allowedEnvpPrefixes: [],
          sandboxCwd: false,
        },
      });
      expect(enforcer.checkProcessSpawn("node")).toBeNull();
      enforcer.trackSpawnedProcess();
      expect(enforcer.checkProcessSpawn("python3")).toBeNull();
      enforcer.trackSpawnedProcess();
      const violation = enforcer.checkProcessSpawn("node");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("process_spawn");
      expect(violation!.detail).toContain("2");
    });

    it("tracks and releases spawned processes", () => {
      const enforcer = new ResourceEnforcer(["process:spawn"], {
        processSpawn: { maxProcesses: 1, allowedBinaries: ["node"], allowedEnvpPrefixes: [], sandboxCwd: false },
      });
      enforcer.trackSpawnedProcess();
      expect(enforcer.currentProcessCount).toBe(1);
      enforcer.releaseProcess();
      expect(enforcer.currentProcessCount).toBe(0);
      // Now should be able to spawn again
      expect(enforcer.checkProcessSpawn("node")).toBeNull();
    });

    it("enforces sandbox cwd boundary", () => {
      const enforcer = new ResourceEnforcer(["process:spawn"], {
        processSpawn: {
          maxProcesses: 5,
          allowedBinaries: ["node"],
          allowedEnvpPrefixes: [],
          sandboxCwd: true,
        },
      });
      // Valid cwd inside sandbox
      expect(enforcer.checkProcessSpawn("node", "/sandbox/workdir", "/sandbox")).toBeNull();
      // Invalid cwd outside sandbox
      const violation = enforcer.checkProcessSpawn("node", "/etc/passwd", "/sandbox");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("process_spawn");
    });
  });

  // ── Environment Variable Access ─────────────────────────────────

  describe("environment variable access", () => {
    it("blocks env access when capability not granted", () => {
      const enforcer = new ResourceEnforcer([], {
        envAccess: { mode: "allowlist", entries: ["PATH"] },
      });
      const violation = enforcer.checkEnvAccess("PATH");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("env_access");
    });

    it("soft-blocks blocklisted env vars", () => {
      const enforcer = new ResourceEnforcer(["env:read"], {
        envAccess: { mode: "blocklist", entries: ["SECRET", "TOKEN"] },
      });
      const violation = enforcer.checkEnvAccess("MY_SECRET_KEY");
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("env_access");
      expect(violation!.blocked).toBe(false); // Soft enforcement
    });

    it("allows env vars not in blocklist", () => {
      const enforcer = new ResourceEnforcer(["env:read"], {
        envAccess: { mode: "blocklist", entries: ["SECRET", "TOKEN"] },
      });
      expect(enforcer.checkEnvAccess("PATH")).toBeNull();
      expect(enforcer.checkEnvAccess("HOME")).toBeNull();
    });

    it("enforces allowlist mode", () => {
      const enforcer = new ResourceEnforcer(["env:read"], {
        envAccess: { mode: "allowlist", entries: ["PATH", "HOME", "NODE"] },
      });
      expect(enforcer.checkEnvAccess("PATH")).toBeNull();
      expect(enforcer.checkEnvAccess("NODE_ENV")).toBeNull(); // matches prefix
      const violation = enforcer.checkEnvAccess("AWS_ACCESS_KEY_ID");
      expect(violation).not.toBeNull();
    });
  });

  // ── Time Budget ─────────────────────────────────────────────────

  describe("time budget", () => {
    it("returns remaining time after start", async () => {
      const enforcer = new ResourceEnforcer(["execution:compute"], {
        timeBudget: { maxWallClockMs: 1000, maxCpuMs: 500 },
      });
      enforcer.startExecutionTimer();
      const remaining = enforcer.getRemainingTimeMs();
      expect(remaining).toBeGreaterThan(900);
      expect(remaining).toBeLessThanOrEqual(1000);
    });

    it("reports not expired when within budget", async () => {
      const enforcer = new ResourceEnforcer(["execution:compute"], {
        timeBudget: { maxWallClockMs: 60_000, maxCpuMs: 30_000 },
      });
      enforcer.startExecutionTimer();
      expect(enforcer.isTimeExpired).toBe(false);
    });

    it("expires after time budget elapses", async () => {
      const enforcer = new ResourceEnforcer(["execution:compute"], {
        timeBudget: { maxWallClockMs: 20, maxCpuMs: 20 },
      });
      enforcer.startExecutionTimer();
      await new Promise((r) => setTimeout(r, 100));
      expect(enforcer.isTimeExpired).toBe(true);
      const violation = enforcer.checkTimeBudget();
      expect(violation).not.toBeNull();
      expect(violation!.type).toBe("time_budget");
      expect(violation!.blocked).toBe(true);
    });

    it("returns null for time budget before start", () => {
      const enforcer = new ResourceEnforcer(["execution:compute"]);
      expect(enforcer.checkTimeBudget()).toBeNull();
    });
  });

  // ── fromEnvironment Factory ─────────────────────────────────────

  describe("fromEnvironment factory", () => {
    it("creates enforcer with browser and network capabilities", () => {
      const env = createTestEnv("browser-env", ["BROWSER_INTERACT", "NETWORK_ACCESS", "FILESYSTEM_WRITE"]);
      const enforcer = ResourceEnforcer.fromEnvironment(env);
      expect(enforcer.hasCapability("browser:interact")).toBe(true);
      expect(enforcer.hasCapability("network:egress")).toBe(true);
      expect(enforcer.hasCapability("fs:write")).toBe(true);
      expect(enforcer.hasCapability("env:read")).toBe(true);
      expect(enforcer.hasCapability("execution:compute")).toBe(true);
      expect(enforcer.hasCapability("process:spawn")).toBe(false);
    });

    it("creates minimal enforcer for sandbox-only environment", () => {
      const env = createTestEnv("sandbox-env", ["FILESYSTEM_WRITE"]);
      const enforcer = ResourceEnforcer.fromEnvironment(env);
      expect(enforcer.hasCapability("fs:write")).toBe(true);
      expect(enforcer.hasCapability("network:egress")).toBe(false);
      expect(enforcer.hasCapability("process:spawn")).toBe(false);
      expect(enforcer.hasCapability("env:read")).toBe(true); // default
    });

    it("accepts additional config overrides", () => {
      const env = createTestEnv("locked-env", ["NETWORK_ACCESS"]);
      const enforcer = ResourceEnforcer.fromEnvironment(env, {
        networkEgress: {
          allowedHosts: ["api.trusted.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          blockPrivateRanges: true,
          blockLoopback: true,
        },
      });
      expect(enforcer.hasCapability("network:egress")).toBe(true);
      expect(enforcer.checkNetworkEgress("https://api.trusted.com/v1")).toBeNull();
      expect(enforcer.checkNetworkEgress("https://evil.com")).not.toBeNull();
    });
  });
});
