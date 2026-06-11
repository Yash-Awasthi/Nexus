import { LocalServiceDiscovery, HealthMonitor } from "../orchestration/service-discovery";
import { IConfigLoader } from "../runtime/config-loader";

describe("Milestone 3: Service Discovery & Health Monitoring", () => {
  it("should register dynamic services and update statuses dynamically", async () => {
    const discovery = new LocalServiceDiscovery();

    await discovery.registerService("floci", 4566, { type: "docker" });
    const list = await discovery.listServices();

    expect(list.length).toBe(1);
    expect(list[0].name).toBe("floci");
    expect(list[0].status).toBe("healthy");

    await discovery.registerService("floci", 4566, { type: "docker", status: "offline" });
    const floci = await discovery.getService("floci");
    expect(floci?.status).toBe("offline");
  });

  it("should monitor config services and evaluate dynamic checks", async () => {
    const discovery = new LocalServiceDiscovery();

    // Mock Config Loader
    const mockLoader: IConfigLoader = {
      loadPorts: jest.fn(),
      loadServices: jest.fn().mockResolvedValue({
        services: {
          floci: { type: "docker", port: 4566 },
          fcc: { type: "process", port: 8082 }
        }
      }),
      loadHealthchecks: jest.fn().mockResolvedValue({
        healthchecks: {
          floci: { path: "/health", interval: 1000 }
        }
      }),
      loadRuntime: jest.fn()
    };

    const monitor = new HealthMonitor(mockLoader, discovery);
    await monitor.startMonitoring();

    const services = await discovery.listServices();
    expect(services.length).toBe(2);
    expect(services.map((s) => s.name)).toContain("floci");
    expect(services.map((s) => s.name)).toContain("fcc");

    await monitor.stopMonitoring();
  });

  it("should report degraded health when services transition through states", async () => {
    const discovery = new LocalServiceDiscovery();
    const mockLoader: IConfigLoader = {
      loadPorts: jest.fn(),
      loadServices: jest.fn().mockResolvedValue({
        services: {
          floci: { type: "docker", port: 4566 },
          fcc: { type: "process", port: 8082 }
        }
      }),
      loadHealthchecks: jest.fn().mockResolvedValue({
        healthchecks: {
          floci: { path: "/health", interval: 100 }
        }
      }),
      loadRuntime: jest.fn()
    };

    const monitor = new HealthMonitor(mockLoader, discovery);
    await monitor.startMonitoring();

    // Initially register floci as healthy
    await discovery.registerService("floci", 4566, { type: "docker" });
    let floci = await discovery.getService("floci");
    expect(floci?.status).toBe("healthy");

    // Transition to degraded
    await discovery.registerService("floci", 4566, { type: "docker", status: "degraded" });
    floci = await discovery.getService("floci");
    expect(floci?.status).toBe("degraded");

    // Transition to offline
    await discovery.registerService("floci", 4566, { type: "docker", status: "offline" });
    floci = await discovery.getService("floci");
    expect(floci?.status).toBe("offline");

    // Recovery back to healthy
    await discovery.registerService("floci", 4566, { type: "docker", status: "healthy" });
    floci = await discovery.getService("floci");
    expect(floci?.status).toBe("healthy");

    await monitor.stopMonitoring();
  });

  it("should handle missing healthcheck config without crashing", async () => {
    const discovery = new LocalServiceDiscovery();
    const mockLoader: IConfigLoader = {
      loadPorts: jest.fn(),
      loadServices: jest.fn().mockResolvedValue({
        services: {
          unknown: { type: "docker", port: 9999 }
        }
      }),
      loadHealthchecks: jest.fn().mockResolvedValue({
        healthchecks: {}  // No healthcheck for 'unknown'
      }),
      loadRuntime: jest.fn()
    };

    const monitor = new HealthMonitor(mockLoader, discovery);
    await expect(monitor.startMonitoring()).resolves.not.toThrow();
    await monitor.stopMonitoring();
  });
});
