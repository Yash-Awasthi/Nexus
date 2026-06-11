import { MCPRuntime } from "../orchestration/mcp-adapter";
import { MCPServerRegistry } from "../orchestration/mcp-registry";
import { IMCPTransport, IMCPTask } from "../orchestration/interfaces/mcp.interface";
import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";

class MockMCPTransport implements IMCPTransport {
  private simulateDelayMs = 0;
  private connected = false;

  constructor(simulateDelayMs = 0) {
    this.simulateDelayMs = simulateDelayMs;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(message: any): Promise<any> {
    if (this.simulateDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulateDelayMs));
    }

    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};

      if (name === "echo") {
        return { content: [{ type: "text", text: args.input || "hello" }] };
      }
      if (name === "fail") {
        throw new Error("Simulated tool invocation crash");
      }
    }

    throw new Error(`Unsupported message or tool: ${message.method}`);
  }
}

describe("Milestone 2: MCP Tool Execution Fabric & Timeout Limits", () => {
  it("should execute tool calls successfully and log detailed metrics", async () => {
    const registry = new MCPServerRegistry();
    const metrics = new MetricsCollector();
    const tracer = new TraceRecorder();

    const transport = new MockMCPTransport();
    await registry.registerServer(
      {
        name: "echo-server",
        transportType: "stdio",
        endpoint: "node bin.js",
        status: "active",
        tools: ["echo"]
      },
      transport
    );

    const runtime = new MCPRuntime(registry, metrics, tracer);

    const task: IMCPTask = {
      id: "mcp-task-01",
      serverName: "echo-server",
      toolName: "echo",
      arguments: { input: "world" },
      correlationId: "correlation-01"
    };

    const res = await runtime.executeTask(task);
    expect(res.success).toBe(true);
    expect(res.output).toBe("world");

    const runtimeMetrics = await runtime.getMetrics();
    expect(runtimeMetrics.invocations).toBe(1);
    expect(runtimeMetrics.successes).toBe(1);
    expect(runtimeMetrics.failures).toBe(0);

    const traceSpans = tracer.getSpans();
    expect(traceSpans.length).toBe(1);
    expect(traceSpans[0].name).toBe("mcp.tool.invoke");
    expect(traceSpans[0].metadata?.toolName).toBe("echo");
  });

  it("should catch and report execution timeouts cleanly", async () => {
    const registry = new MCPServerRegistry();
    const metrics = new MetricsCollector();
    const tracer = new TraceRecorder();

    // 50ms delay for simulation
    const transport = new MockMCPTransport(50);
    await registry.registerServer(
      {
        name: "slow-server",
        transportType: "http",
        endpoint: "http://localhost/slow",
        status: "active",
        tools: ["echo"]
      },
      transport
    );

    const runtime = new MCPRuntime(registry, metrics, tracer);

    const task: IMCPTask = {
      id: "mcp-task-slow",
      serverName: "slow-server",
      toolName: "echo",
      arguments: { input: "late" },
      correlationId: "correlation-slow",
      timeoutMs: 10 // enforce aggressive 10ms timeout
    };

    const res = await runtime.executeTask(task);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Execution Timeout");

    const runtimeMetrics = await runtime.getMetrics();
    expect(runtimeMetrics.timeouts).toBe(1);
    expect(runtimeMetrics.failures).toBe(1);
  });
});
