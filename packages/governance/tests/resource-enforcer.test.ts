// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";

import { ResourceEnforcer } from "../src/resource-enforcer.js";
import type { ResourceCapability } from "../src/resource-enforcer.js";

function makeEnforcer(
  caps: ResourceCapability[] = [],
  config?: ConstructorParameters<typeof ResourceEnforcer>[1],
): ResourceEnforcer {
  return new ResourceEnforcer(caps, config);
}

describe("ResourceEnforcer — capability checks", () => {
  it("hasCapability returns true for granted capabilities", () => {
    const e = makeEnforcer(["network:egress", "fs:read"]);
    expect(e.hasCapability("network:egress")).toBe(true);
    expect(e.hasCapability("fs:read")).toBe(true);
  });

  it("hasCapability returns false for missing capabilities", () => {
    const e = makeEnforcer(["network:egress"]);
    expect(e.hasCapability("process:spawn")).toBe(false);
  });

  it("getCapabilities returns all granted capabilities", () => {
    const caps: ResourceCapability[] = ["network:egress", "env:read", "execution:compute"];
    const e = makeEnforcer(caps);
    expect(e.getCapabilities()).toEqual(expect.arrayContaining(caps));
  });
});

describe("ResourceEnforcer — network egress", () => {
  it("blocks requests when network:egress is not granted", () => {
    const e = makeEnforcer([]);
    const v = e.checkNetworkEgress("https://api.example.com");
    expect(v).not.toBeNull();
    expect(v?.blocked).toBe(true);
    expect(v?.type).toBe("network_egress");
  });

  it("blocks loopback URLs via SSRF guard", () => {
    const e = makeEnforcer(["network:egress"]);
    const v = e.checkNetworkEgress("http://localhost/admin");
    expect(v?.blocked).toBe(true);
  });

  it("blocks 169.254.169.254 metadata endpoint", () => {
    const e = makeEnforcer(["network:egress"]);
    const v = e.checkNetworkEgress("http://169.254.169.254/latest/meta-data/");
    expect(v?.blocked).toBe(true);
  });

  it("allows public HTTPS requests without allowedHosts restriction", () => {
    const e = makeEnforcer(["network:egress"], {
      networkEgress: {
        allowedHosts: [],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        blockPrivateRanges: true,
        blockLoopback: true,
      },
    });
    const v = e.checkNetworkEgress("https://api.openai.com/v1/completions");
    expect(v).toBeNull();
  });

  it("blocks host not in allowedHosts list", () => {
    const e = makeEnforcer(["network:egress"], {
      networkEgress: {
        allowedHosts: ["api.example.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        blockPrivateRanges: true,
        blockLoopback: true,
      },
    });
    const v = e.checkNetworkEgress("https://evil.com/steal");
    expect(v?.blocked).toBe(true);
    expect(v?.detail).toMatch(/allowlist/);
  });

  it("allows host that matches allowed domain", () => {
    const e = makeEnforcer(["network:egress"], {
      networkEgress: {
        allowedHosts: ["example.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        blockPrivateRanges: true,
        blockLoopback: true,
      },
    });
    const v = e.checkNetworkEgress("https://api.example.com/v1");
    expect(v).toBeNull();
  });

  it("blocks non-allowed port", () => {
    const e = makeEnforcer(["network:egress"], {
      networkEgress: {
        allowedHosts: [],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        blockPrivateRanges: true,
        blockLoopback: true,
      },
    });
    const v = e.checkNetworkEgress("https://api.example.com:8080/path");
    expect(v?.blocked).toBe(true);
    expect(v?.detail).toMatch(/port/i);
  });
});

describe("ResourceEnforcer — process spawning", () => {
  it("blocks spawn when process:spawn is not granted", () => {
    const e = makeEnforcer([]);
    const v = e.checkProcessSpawn("node");
    expect(v?.blocked).toBe(true);
    expect(v?.type).toBe("process_spawn");
  });

  it("blocks spawn when binary not in allowedBinaries", () => {
    const e = makeEnforcer(["process:spawn"], {
      processSpawn: {
        maxProcesses: 5,
        allowedBinaries: ["python3"],
        allowedEnvpPrefixes: [],
        sandboxCwd: false,
      },
    });
    const v = e.checkProcessSpawn("bash");
    expect(v?.blocked).toBe(true);
    expect(v?.detail).toMatch(/allowlist/i);
  });

  it("allows allowed binary", () => {
    const e = makeEnforcer(["process:spawn"], {
      processSpawn: {
        maxProcesses: 5,
        allowedBinaries: ["node"],
        allowedEnvpPrefixes: [],
        sandboxCwd: false,
      },
    });
    const v = e.checkProcessSpawn("node");
    expect(v).toBeNull();
  });

  it("blocks when process count limit reached", () => {
    const e = makeEnforcer(["process:spawn"], {
      processSpawn: {
        maxProcesses: 1,
        allowedBinaries: [],
        allowedEnvpPrefixes: [],
        sandboxCwd: false,
      },
    });
    e.trackSpawnedProcess();
    const v = e.checkProcessSpawn("node");
    expect(v?.blocked).toBe(true);
    expect(v?.detail).toMatch(/limit/i);
  });

  it("trackSpawnedProcess / releaseProcess adjusts counter", () => {
    const e = makeEnforcer(["process:spawn"]);
    expect(e.currentProcessCount).toBe(0);
    e.trackSpawnedProcess();
    e.trackSpawnedProcess();
    expect(e.currentProcessCount).toBe(2);
    e.releaseProcess();
    expect(e.currentProcessCount).toBe(1);
  });
});

describe("ResourceEnforcer — environment access", () => {
  it("blocks env:read when capability not granted", () => {
    const e = makeEnforcer([]);
    const v = e.checkEnvAccess("PATH");
    expect(v?.blocked).toBe(true);
  });

  it("blocklist mode: flags vars matching blocked patterns (soft block)", () => {
    const e = makeEnforcer(["env:read"], {
      envAccess: { mode: "blocklist", entries: ["API_KEY", "SECRET"] },
    });
    const v = e.checkEnvAccess("GROQ_API_KEY");
    expect(v).not.toBeNull();
    expect(v?.blocked).toBe(false); // Soft enforcement
    expect(v?.severity).toBe("warn");
  });

  it("blocklist mode: allows unlisted vars", () => {
    const e = makeEnforcer(["env:read"], {
      envAccess: { mode: "blocklist", entries: ["SECRET"] },
    });
    const v = e.checkEnvAccess("NODE_ENV");
    expect(v).toBeNull();
  });

  it("allowlist mode: blocks vars not in allowlist", () => {
    const e = makeEnforcer(["env:read"], {
      envAccess: { mode: "allowlist", entries: ["PATH", "HOME"] },
    });
    const v = e.checkEnvAccess("GROQ_API_KEY");
    expect(v).not.toBeNull();
  });

  it("allowlist mode: allows listed vars", () => {
    const e = makeEnforcer(["env:read"], {
      envAccess: { mode: "allowlist", entries: ["PATH"] },
    });
    const v = e.checkEnvAccess("PATH");
    expect(v).toBeNull();
  });
});

describe("ResourceEnforcer — time budget", () => {
  it("returns null before timer is started", () => {
    const e = makeEnforcer(["execution:compute"]);
    expect(e.checkTimeBudget()).toBeNull();
  });

  it("getRemainingTimeMs returns full budget before start", () => {
    const e = makeEnforcer([], {
      timeBudget: { maxWallClockMs: 5000, maxCpuMs: 2000 },
    });
    expect(e.getRemainingTimeMs()).toBe(5000);
  });

  it("detects expired budget after artificial elapsed time", async () => {
    const e = makeEnforcer([], {
      timeBudget: { maxWallClockMs: 10, maxCpuMs: 10 },
    });
    e.startExecutionTimer();
    await new Promise((r) => setTimeout(r, 25));
    expect(e.isTimeExpired).toBe(true);
    const v = e.checkTimeBudget();
    expect(v?.blocked).toBe(true);
    expect(v?.type).toBe("time_budget");
  });

  it("is not expired immediately after start with generous budget", () => {
    const e = makeEnforcer([], {
      timeBudget: { maxWallClockMs: 60_000, maxCpuMs: 30_000 },
    });
    e.startExecutionTimer();
    expect(e.isTimeExpired).toBe(false);
  });
});

describe("ResourceEnforcer.fromEnvironment()", () => {
  it("grants network:egress for NETWORK_ACCESS environment", () => {
    const env = {
      name: "net-env",
      capabilities: ["NETWORK_ACCESS"],
      telemetry: { successRate: 1, avgLatencyMs: 0, requestCount: 0 },
    };
    const e = ResourceEnforcer.fromEnvironment(env);
    expect(e.hasCapability("network:egress")).toBe(true);
  });

  it("grants browser capabilities for BROWSER_INTERACT environment", () => {
    const env = {
      name: "browser-env",
      capabilities: ["BROWSER_INTERACT"],
      telemetry: { successRate: 1, avgLatencyMs: 0, requestCount: 0 },
    };
    const e = ResourceEnforcer.fromEnvironment(env);
    expect(e.hasCapability("browser:interact")).toBe(true);
    expect(e.hasCapability("network:egress")).toBe(true);
  });

  it("always grants env:read and execution:compute by default", () => {
    const env = {
      name: "bare-env",
      capabilities: [],
      telemetry: { successRate: 1, avgLatencyMs: 0, requestCount: 0 },
    };
    const e = ResourceEnforcer.fromEnvironment(env);
    expect(e.hasCapability("env:read")).toBe(true);
    expect(e.hasCapability("execution:compute")).toBe(true);
  });
});
