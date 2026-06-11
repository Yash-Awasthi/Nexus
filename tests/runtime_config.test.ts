import { YAMLConfigLoader } from "../runtime/config-loader";
import * as path from "path";

describe("Runtime Config Loader System", () => {
  const loader = new YAMLConfigLoader({
    portsPath: path.join(__dirname, "../runtime/ports.yaml"),
    servicesPath: path.join(__dirname, "../runtime/services.yaml"),
    healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
    runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
  });

  it("should successfully load strongly typed ports config", async () => {
    const ports = await loader.loadPorts();
    expect(ports.floci).toBe(4566);
    expect(ports.fcc).toBe(8082);
    expect(ports.mcp).toBe(8000);
    expect(ports.ollama).toBe(11434);
  });

  it("should successfully load strongly typed services config", async () => {
    const services = await loader.loadServices();
    expect(services.services.floci.type).toBe("docker");
    expect(services.services.floci.port).toBe(4566);
    expect(services.services.mcp.cmd).toBe("python runtime/mcp/ghoststack_mcp_server.py");
  });

  it("should successfully load strongly typed healthchecks config", async () => {
    const health = await loader.loadHealthchecks();
    expect(health.healthchecks.floci.path).toBe("/_floci/health");
    expect(health.healthchecks.floci.interval).toBe(5000);
  });

  it("should successfully load strongly typed global runtime config", async () => {
    const runtime = await loader.loadRuntime();
    expect(runtime.version).toBe("1.0.0");
    expect(runtime.environment).toBe("development");
    expect(runtime.storage.mode).toBe("hybrid");
  });
});
