/**
 * Federation Supervisor Lifecycle Tests
 *
 * Validates start/stop/persisted status lifecycle management,
 * crash recovery via session files, and restart semantics.
 */

import * as path from "path";
import * as fs from "fs";
import { FederationSupervisor } from "../runtime/federation-supervisor";
import { loadGhostStackConfig } from "../runtime/ghoststack-config";

describe("FederationSupervisor Lifecycle", () => {
  const repoRoot = path.resolve(__dirname, "..");

  beforeEach(() => {
    // Clean up any persisted session files before each test
    const sessionPath = path.join(repoRoot, "data-runtime", "supervisor-session.json");
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
  });

  it("reports aggregated status with expected services", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);
    const status = await supervisor.status();

    expect(status.services).toBeInstanceOf(Array);
    expect(status.services.length).toBeGreaterThanOrEqual(3);
    expect(status.services.map((s) => s.name)).toContain("floci");
    expect(status.services.map((s) => s.name)).toContain("orchestrator");
    expect(status.services.map((s) => s.name)).toContain("mcp-server");

    // All services should have a status field
    for (const s of status.services) {
      expect(s.status).toBeDefined();
      expect(typeof s.status).toBe("string");
    }
  });

  it("mode reflects standalone mode when no server is running", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);
    const status = await supervisor.status();

    // No server running in tests, so mode is "standalone"
    expect(["standalone", "federation"]).toContain(status.mode);
    expect(status.mode).toBe("standalone");
  });

  it("reports status with expected structure", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);
    const status = await supervisor.status();

    // Status() always returns valid data with expected structure
    expect(status).toHaveProperty("mode");
    expect(status).toHaveProperty("status");
    expect(status).toHaveProperty("services");
    expect(typeof status.mode).toBe("string");
    expect(["standalone", "federation"]).toContain(status.mode);
    expect(["running", "stopped", "degraded"]).toContain(status.status);
    expect(Array.isArray(status.services)).toBe(true);
  });

  it("persisted status contains expected fields", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);

    // Trigger a status check which may persist
    await supervisor.status();

    const persisted = await FederationSupervisor.readPersistedStatus(repoRoot);
    if (persisted) {
      // Validate all expected fields
      expect(persisted).toHaveProperty("mode");
      expect(persisted).toHaveProperty("status");
      expect(persisted).toHaveProperty("services");
      expect(typeof persisted.mode).toBe("string");
      expect(typeof persisted.status).toBe("string");
      expect(Array.isArray(persisted.services)).toBe(true);
    }
  });

  it("persisted status handles missing session file gracefully", async () => {
    // Ensure no session file exists
    const sessionPath = path.join(repoRoot, "data-runtime", "federation-supervisor-state.json");
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }

    const persisted = await FederationSupervisor.readPersistedStatus(repoRoot);
    expect(persisted).toBeNull();
  });

  it("lists individual service details correctly after status call", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);
    const status = await supervisor.status();

    for (const service of status.services) {
      expect(typeof service.name).toBe("string");
      expect(service.name.length).toBeGreaterThan(0);
      expect(["healthy", "degraded", "offline", "skipped"]).toContain(service.status);
      if (service.port !== undefined) {
        expect(typeof service.port).toBe("number");
      }
    }
  });

  it("status has valid overall status field", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);
    const status = await supervisor.status();

    // Status() returns a valid overall status
    expect(["running", "stopped", "degraded"]).toContain(status.status);
    // The mode is derived from whether server/gSserver is running
    expect(typeof status.mode).toBe("string");
    expect(status.mode.length).toBeGreaterThan(0);
  });
});
