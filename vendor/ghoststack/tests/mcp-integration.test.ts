import { FileEventStore } from "../orchestration/persistence-manager";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";
import { RuntimeInspector } from "../orchestration/runtime-inspector";
import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api";
import { MCPServerRegistry } from "../orchestration/mcp-registry";
import { MCPRuntime } from "../orchestration/mcp-adapter";
import { IMCPTransport, IMCPTask } from "../orchestration/interfaces/mcp.interface";
import * as path from "path";
import * as fs from "fs";

class MockMCPTransport implements IMCPTransport {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(_message: any): Promise<any> {
    return { content: [{ type: "text", text: `provisions resolved` }] };
  }
}

describe("Milestone 3: MCP End-to-End Orchestrator Integration & Observability", () => {
  const testDir = path.join(__dirname, "../temp-mcp-integration-db");
  const eventLogPath = path.join(testDir, "mcp_events.jsonl");

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should integrate MCP tasks into the pipeline, expose servers/tools/executions logs, and support diagnostics", async () => {
    const eventStore = new FileEventStore(eventLogPath);

    // Initialize telemetry
    const metrics = new MetricsCollector();
    const tracer = new TraceRecorder();
    const queue = new MemoryQueueBackend();
    const discovery = {
      listServices: async () => []
    } as any;

    // Initialize MCP Registry and Runtime
    const mcpRegistry = new MCPServerRegistry();
    const mcpRuntime = new MCPRuntime(mcpRegistry, metrics, tracer);

    // Register a mock MCP server
    const mockTransport = new MockMCPTransport();
    await mcpRegistry.registerServer(
      {
        name: "financial-news-mcp",
        transportType: "stdio",
        endpoint: "node bin.js",
        status: "active",
        tools: ["scrape_cnbc", "summarize_headlines"]
      },
      mockTransport
    );

    const inspector = new RuntimeInspector(metrics, queue, discovery, eventStore, mcpRuntime, mcpRegistry);
    const api = new RuntimeDiagnosticAPI(inspector);

    // Execute an MCP tool task directly via our runtime
    const mcpTask: IMCPTask = {
      id: "mcp-execution-01",
      serverName: "financial-news-mcp",
      toolName: "scrape_cnbc",
      arguments: { limit: 5 },
      correlationId: "correlation-mcp-99"
    };

    const runResult = await mcpRuntime.executeTask(mcpTask);
    expect(runResult.success).toBe(true);
    expect(runResult.output).toBe("provisions resolved");

    // Assert API Observability GET Endpoint returns
    // 1. GET /runtime/mcp
    const mcpSummary = await api.handle("GET", "/runtime/mcp");
    expect(mcpSummary.metrics.invocations).toBe(1);

    // 2. GET /runtime/mcp/servers
    const mcpServers = await api.handle("GET", "/runtime/mcp/servers");
    expect(mcpServers.length).toBe(1);
    expect(mcpServers[0].name).toBe("financial-news-mcp");

    // 3. GET /runtime/mcp/tools
    const mcpTools = await api.handle("GET", "/runtime/mcp/tools");
    expect(mcpTools).toContain("financial-news-mcp:scrape_cnbc");

    // 4. GET /runtime/mcp/executions
    const mcpExecutions = await api.handle("GET", "/runtime/mcp/executions");
    expect(mcpExecutions.length).toBe(1);
    expect(mcpExecutions[0].correlationId).toBe("correlation-mcp-99");
  });
});
