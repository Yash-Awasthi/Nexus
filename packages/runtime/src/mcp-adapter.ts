import { IMCPRuntime, IMCPTask, IMCPExecutionResult, IMCPRuntimeMetrics } from "./interfaces/mcp.interface.js";
import { IMCPServerRegistry } from "./interfaces/mcp.interface.js";
import { IMetricsCollector, ITraceRecorder } from "./interfaces/observability.interface.js";

export class MCPRuntime implements IMCPRuntime {
  private registry: IMCPServerRegistry;
  private metricsCollector?: IMetricsCollector;
  private tracer?: ITraceRecorder;
  private executionsLog: IMCPExecutionResult[] = [];
  private blocklist: Set<string>;

  // Metrics parameters
  private totalInvocations = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalTimeouts = 0;
  private accumDurationMs = 0;

  constructor(
    registry: IMCPServerRegistry,
    metricsCollector?: IMetricsCollector,
    tracer?: ITraceRecorder,
    customBlocklist?: string[]
  ) {
    this.registry = registry;
    this.metricsCollector = metricsCollector;
    this.tracer = tracer;
    this.blocklist = new Set(
      customBlocklist || ["shell_execute", "execute_command", "write_system_file", "eval", "delete_directory", "rmrf"]
    );
  }

  async executeTask(task: IMCPTask): Promise<IMCPExecutionResult> {
    const startTimeMs = Date.now();
    this.totalInvocations++;
    this.metricsCollector?.increment("mcp.invocations");

    const traceSpan = this.tracer?.startSpan("mcp.tool.invoke", undefined, {
      taskId: task.id,
      serverName: task.serverName,
      toolName: task.toolName,
      correlationId: task.correlationId
    });

    // 1. Tool Blocklist Validation
    if (this.blocklist.has(task.toolName)) {
      this.totalFailures++;
      this.metricsCollector?.increment("mcp.failures");

      const res: IMCPExecutionResult = {
        success: false,
        error: `Tool execution blocked by safety policy: ${task.toolName}`,
        durationMs: Date.now() - startTimeMs,
        correlationId: task.correlationId
      };

      this.executionsLog.push(res);
      if (traceSpan) {
        this.tracer?.endSpan(traceSpan.spanId, { status: "failed", error: res.error });
      }
      return res;
    }

    const serverEntry = await this.registry.getServer(task.serverName);
    if (!serverEntry) {
      this.totalFailures++;
      this.metricsCollector?.increment("mcp.failures");

      const res: IMCPExecutionResult = {
        success: false,
        error: `Server not found: ${task.serverName}`,
        durationMs: Date.now() - startTimeMs,
        correlationId: task.correlationId
      };

      this.executionsLog.push(res);
      if (traceSpan) {
        this.tracer?.endSpan(traceSpan.spanId, { status: "failed", error: res.error });
      }
      return res;
    }

    const timeoutMs = task.timeoutMs || 5000;
    let timeoutId: any;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Execution Timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const executePromise = (async () => {
      await serverEntry.transport.connect();
      try {
        const res = await serverEntry.transport.send({
          method: "tools/call",
          params: {
            name: task.toolName,
            arguments: task.arguments
          }
        });
        return res;
      } finally {
        await serverEntry.transport.disconnect();
      }
    })();

    try {
      const rawResult = await Promise.race([executePromise, timeoutPromise]);
      clearTimeout(timeoutId);

      const durationMs = Date.now() - startTimeMs;
      this.totalSuccesses++;
      this.accumDurationMs += durationMs;
      this.metricsCollector?.increment("mcp.successes");
      this.metricsCollector?.recordTiming("mcp.latency", durationMs);

      // Extract text content from typical MCP response
      let output: any = rawResult;
      if (rawResult && Array.isArray(rawResult.content)) {
        output = rawResult.content[0]?.text || rawResult;
      }

      const res: IMCPExecutionResult = {
        success: true,
        output,
        durationMs,
        correlationId: task.correlationId
      };

      this.executionsLog.push(res);
      if (traceSpan) {
        this.tracer?.endSpan(traceSpan.spanId, { status: "success", durationMs });
      }
      return res;
    } catch (err: any) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTimeMs;
      this.totalFailures++;
      this.accumDurationMs += durationMs;
      this.metricsCollector?.increment("mcp.failures");

      const errorMessage = err?.message || String(err);
      const isTimeout = errorMessage.includes("Execution Timeout");
      if (isTimeout) {
        this.totalTimeouts++;
        this.metricsCollector?.increment("mcp.timeouts");
      }

      const res: IMCPExecutionResult = {
        success: false,
        error: errorMessage,
        durationMs,
        correlationId: task.correlationId
      };

      this.executionsLog.push(res);
      if (traceSpan) {
        this.tracer?.endSpan(traceSpan.spanId, { status: "failed", error: errorMessage });
      }
      return res;
    }
  }

  async getMetrics(): Promise<IMCPRuntimeMetrics> {
    return {
      invocations: this.totalInvocations,
      successes: this.totalSuccesses,
      failures: this.totalFailures,
      timeouts: this.totalTimeouts,
      avgDurationMs: this.totalInvocations > 0 ? this.accumDurationMs / this.totalInvocations : 0
    };
  }

  async getExecutionsLog(): Promise<IMCPExecutionResult[]> {
    return [...this.executionsLog];
  }
}
