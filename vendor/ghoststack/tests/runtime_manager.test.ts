import { RuntimeManager } from "../orchestration/runtime-manager";
import { YAMLConfigLoader } from "../runtime/config-loader";
import * as path from "path";

const loader = new YAMLConfigLoader({
  portsPath: path.join(__dirname, "../runtime/ports.yaml"),
  servicesPath: path.join(__dirname, "../runtime/services.yaml"),
  healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
  runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
});

describe("RuntimeManager", () => {
  describe("getActiveServices", () => {
    it("should detect config-declared services (floci, fcc, mcp)", async () => {
      const rm = new RuntimeManager(loader);
      const active = await rm.getActiveServices();
      expect(active).toBeDefined();
      expect(active).toContain("floci");
      expect(active).toContain("fcc");
      expect(active).toContain("mcp");
    });

    it("returns runtime-registered services even when not in config", async () => {
      const rm = new RuntimeManager(loader);
      rm.registerService("custom-svc", "running", "test service");
      const active = await rm.getActiveServices();
      expect(active).toContain("custom-svc");
    });
  });

  describe("registerService / unregisterService", () => {
    it("registers a new service with default status unknown", () => {
      const rm = new RuntimeManager(loader);
      rm.registerService("svc-a");
      const rec = rm.getServiceRecord("svc-a");
      expect(rec).toBeDefined();
      expect(rec!.status).toBe("unknown");
      expect(rec!.restartCount).toBe(0);
    });

    it("updates an already-registered service status without resetting restartCount", () => {
      const rm = new RuntimeManager(loader);
      rm.registerService("svc-b", "running");
      rm.registerService("svc-b", "degraded", "degraded detail");
      const rec = rm.getServiceRecord("svc-b");
      expect(rec!.status).toBe("degraded");
      expect(rec!.detail).toBe("degraded detail");
    });

    it("unregisters a service so it no longer appears in records", () => {
      const rm = new RuntimeManager(loader);
      rm.registerService("svc-c");
      rm.unregisterService("svc-c");
      expect(rm.getServiceRecord("svc-c")).toBeUndefined();
    });
  });

  describe("status setters", () => {
    it("markRunning sets status=running and clears lastError", () => {
      const rm = new RuntimeManager(loader);
      rm.markError("worker", "previous error");
      rm.markRunning("worker", "all good");
      const rec = rm.getServiceRecord("worker")!;
      expect(rec.status).toBe("running");
      expect(rec.lastError).toBeUndefined();
      expect(rec.startedAt).toBeInstanceOf(Date);
    });

    it("markStopped sets status=stopped and records stoppedAt", () => {
      const rm = new RuntimeManager(loader);
      rm.markRunning("worker2");
      rm.markStopped("worker2", "graceful shutdown");
      const rec = rm.getServiceRecord("worker2")!;
      expect(rec.status).toBe("stopped");
      expect(rec.stoppedAt).toBeInstanceOf(Date);
    });

    it("markDegraded sets status=degraded with optional detail", () => {
      const rm = new RuntimeManager(loader);
      rm.markDegraded("cache", "high latency");
      const rec = rm.getServiceRecord("cache")!;
      expect(rec.status).toBe("degraded");
      expect(rec.detail).toBe("high latency");
    });

    it("markError sets status=error and stores the message", () => {
      const rm = new RuntimeManager(loader);
      rm.markError("db", "connection refused");
      const rec = rm.getServiceRecord("db")!;
      expect(rec.status).toBe("error");
      expect(rec.lastError).toBe("connection refused");
      expect(rec.detail).toBe("connection refused");
    });
  });

  describe("startService / stopService lifecycle", () => {
    it("startService executes the fn and marks service running", async () => {
      const rm = new RuntimeManager(loader);
      let called = false;
      await rm.startService("svc-start", async () => { called = true; });
      expect(called).toBe(true);
      expect(rm.getServiceRecord("svc-start")!.status).toBe("running");
      expect(rm.getServiceRecord("svc-start")!.restartCount).toBe(1);
    });

    it("startService marks status=error if fn throws and re-throws", async () => {
      const rm = new RuntimeManager(loader);
      await expect(
        rm.startService("broken-svc", async () => { throw new Error("boot failed"); })
      ).rejects.toThrow("boot failed");
      expect(rm.getServiceRecord("broken-svc")!.status).toBe("error");
      expect(rm.getServiceRecord("broken-svc")!.lastError).toBe("boot failed");
    });

    it("stopService executes the fn and marks service stopped", async () => {
      const rm = new RuntimeManager(loader);
      await rm.startService("svc-stop", async () => {});
      await rm.stopService("svc-stop", async () => {});
      expect(rm.getServiceRecord("svc-stop")!.status).toBe("stopped");
      expect(rm.getServiceRecord("svc-stop")!.stoppedAt).toBeInstanceOf(Date);
    });

    it("stopService marks status=error if fn throws and re-throws", async () => {
      const rm = new RuntimeManager(loader);
      await rm.startService("svc-stop-fail", async () => {});
      await expect(
        rm.stopService("svc-stop-fail", async () => { throw new Error("shutdown failed"); })
      ).rejects.toThrow("shutdown failed");
      expect(rm.getServiceRecord("svc-stop-fail")!.status).toBe("error");
    });

    it("restartService stop→start increments restartCount to 2", async () => {
      const rm = new RuntimeManager(loader);
      await rm.startService("svc-restart", async () => {});
      expect(rm.getServiceRecord("svc-restart")!.restartCount).toBe(1);
      await rm.restartService("svc-restart", async () => {}, async () => {});
      expect(rm.getServiceRecord("svc-restart")!.restartCount).toBe(2);
      expect(rm.getServiceRecord("svc-restart")!.status).toBe("running");
    });
  });

  describe("getHealthSummary", () => {
    it("overall=healthy when all services are running", () => {
      const rm = new RuntimeManager(loader);
      rm.markRunning("a");
      rm.markRunning("b");
      const s = rm.getHealthSummary();
      expect(s.overall).toBe("healthy");
      expect(s.runningCount).toBe(2);
      expect(s.errorCount).toBe(0);
      expect(s.degradedCount).toBe(0);
    });

    it("overall=degraded when a service is degraded but none errored", () => {
      const rm = new RuntimeManager(loader);
      rm.markRunning("a");
      rm.markDegraded("b");
      const s = rm.getHealthSummary();
      expect(s.overall).toBe("degraded");
      expect(s.degradedCount).toBe(1);
    });

    it("overall=unhealthy when a service is in error", () => {
      const rm = new RuntimeManager(loader);
      rm.markRunning("a");
      rm.markError("b", "oops");
      const s = rm.getHealthSummary();
      expect(s.overall).toBe("unhealthy");
      expect(s.errorCount).toBe(1);
    });

    it("error status trumps degraded — still unhealthy", () => {
      const rm = new RuntimeManager(loader);
      rm.markDegraded("a");
      rm.markError("b", "fatal");
      const s = rm.getHealthSummary();
      expect(s.overall).toBe("unhealthy");
    });

    it("uptimeMs is a non-negative number", () => {
      const rm = new RuntimeManager(loader);
      const s = rm.getHealthSummary();
      expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it("services list contains all registered records", () => {
      const rm = new RuntimeManager(loader);
      rm.registerService("x");
      rm.registerService("y");
      const s = rm.getHealthSummary();
      const names = s.services.map((r) => r.name);
      expect(names).toContain("x");
      expect(names).toContain("y");
    });

    it("stoppedCount reflects stopped services", () => {
      const rm = new RuntimeManager(loader);
      rm.markRunning("a");
      rm.markStopped("b");
      rm.markStopped("c");
      const s = rm.getHealthSummary();
      expect(s.stoppedCount).toBe(2);
      expect(s.runningCount).toBe(1);
    });
  });
});
