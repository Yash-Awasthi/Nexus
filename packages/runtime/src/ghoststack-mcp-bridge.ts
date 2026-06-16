// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as path from "path";

import { runFederationE2e } from "./e2e-federation.js";
import type { FlociExecutionAdapter } from "./floci-adapter.js";
import { resolveFlociEndpoint } from "./floci-client.js";
import { dispatchExtendedAction, EXTENDED_FLOCI_ACTIONS } from "./floci-extended.js";
import type { IMCPTransport } from "./interfaces/mcp.interface.js";
import { MCPRuntime } from "./mcp-adapter.js";
import { MCPServerRegistry } from "./mcp-registry.js";
import type { GhostStackRuntimeContext } from "./runtime-context.js";
import { resolveSandboxPath } from "./runtime-sandbox.js";
import { loadWorkflowSpecFile, specToWorkflowDefinition } from "./spec-loader.js";

/**
 * In-process MCP transport exposing GhostStack orchestrator capabilities.
 */
class GhostStackMcpBridge implements IMCPTransport {
  private connected = false;

  constructor(private readonly ctx: GhostStackRuntimeContext) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(message: { method: string; params?: Record<string, unknown> }): Promise<unknown> {
    if (!this.connected) {
      throw new Error("GhostStack MCP bridge not connected");
    }

    if (message.method !== "tools/call") {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, method: message.method }) }],
      };
    }

    const name = message.params?.name as string;
    const args = (message.params?.arguments as Record<string, unknown>) ?? {};
    try {
      const text = await this.dispatchTool(name, args);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: (err as Error).message, tool: name }) },
        ],
      };
    }
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "ghoststack_health": {
        const floci = await this.ctx.flociAdapter.probeHealth();
        const agg = await this.ctx.inspector.getHealth();
        return JSON.stringify({ orchestrator: agg, floci }, null, 2);
      }
      case "ghoststack_runtime_snapshot": {
        const snap = await this.ctx.inspector.getSnapshots();
        return JSON.stringify(snap, null, 2);
      }
      case "ghoststack_list_workflows": {
        const list = this.ctx.registry.listWorkflows().map((w) => ({
          id: w.id,
          name: w.name,
          tasks: w.tasks.length,
        }));
        return JSON.stringify(list, null, 2);
      }
      case "ghoststack_load_spec": {
        const specPath = args.specPath as string;
        if (!specPath)
          throw new Error("specPath is required (e.g. specs/demo-etl/workflow-spec.json)");
        const full = path.isAbsolute(specPath) ? specPath : path.join(this.ctx.repoRoot, specPath);
        const spec = loadWorkflowSpecFile(full);
        const workflowId = (args.workflowId as string) || path.basename(path.dirname(full));
        const def = specToWorkflowDefinition(spec, workflowId);
        this.ctx.registry.registerWorkflow(def);
        return JSON.stringify(
          { loaded: workflowId, tasks: def.tasks.length, templateId: spec.template_id },
          null,
          2,
        );
      }
      case "ghoststack_execute_workflow": {
        const workflowId = args.workflowId as string;
        const executionId = (args.executionId as string) || `mcp-exec-${Date.now()}`;
        if (!workflowId) throw new Error("workflowId is required");
        const result = await this.ctx.workflowEngine.executeWorkflow(workflowId, executionId);
        return JSON.stringify(result, null, 2);
      }
      case "ghoststack_workflow_cancel": {
        const executionId = args.executionId as string;
        if (!executionId) throw new Error("executionId is required");
        const result = this.ctx.workflowEngine.cancelExecution(executionId);
        return JSON.stringify({ cancelled: !!result, execution: result ?? null }, null, 2);
      }
      case "ghoststack_workflow_resume": {
        const executionId = args.executionId as string;
        if (!executionId) throw new Error("executionId is required");
        const result = await this.ctx.workflowEngine.resumeExecution(executionId);
        return JSON.stringify({ resumed: !!result, execution: result ?? null }, null, 2);
      }
      case "ghoststack_workflow_checkpoints": {
        const checkpoints = this.ctx.workflowEngine.listCheckpoints();
        return JSON.stringify({ count: checkpoints.length, checkpoints }, null, 2);
      }
      case "ghoststack_workflow_replay": {
        const executionId = args.executionId as string;
        if (!executionId) throw new Error("executionId is required");
        const result = await this.ctx.workflowEngine.replayExecution(executionId);
        return JSON.stringify({ replayed: true, execution: result }, null, 2);
      }
      case "ghoststack_run_e2e": {
        const result = await runFederationE2e(this.ctx, {
          strict: args.strict !== false,
          cleanup: args.cleanup !== false,
        });
        return JSON.stringify(result, null, 2);
      }
      case "ghoststack_floci_execute": {
        const action = args.action as string;
        if (!action) throw new Error("action is required");
        const { action: _a, ...rest } = args;
        const adapter = this.ctx.flociAdapter as FlociExecutionAdapter;
        const result = await adapter.executeAction(action, rest, {
          taskId: `mcp-floci-${Date.now()}`,
          startTime: new Date(),
          attempt: 1,
          environment: {},
          logger: this.ctx.logger,
        });
        return JSON.stringify(result, null, 2);
      }
      case "ghoststack_sandbox_write": {
        const relPath = args.path as string;
        const content = (args.content as string) ?? "";
        if (!relPath) throw new Error("path is required");
        const target = resolveSandboxPath(
          this.ctx.sandbox.workspacesDir,
          this.ctx.sandbox.root,
          relPath,
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
        return JSON.stringify({ written: target, bytes: Buffer.byteLength(content) }, null, 2);
      }
      case "ghoststack_sandbox_read": {
        const relPath = args.path as string;
        if (!relPath) throw new Error("path is required");
        const target = resolveSandboxPath(
          this.ctx.sandbox.workspacesDir,
          this.ctx.sandbox.root,
          relPath,
        );
        const content = fs.readFileSync(target, "utf8");
        return JSON.stringify({ path: target, content }, null, 2);
      }
      case "ghoststack_sandbox_list": {
        const relDir = (args.path as string) || ".";
        const target = resolveSandboxPath(
          this.ctx.sandbox.workspacesDir,
          this.ctx.sandbox.root,
          relDir,
        );
        const entries = fs.readdirSync(target, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        }));
        return JSON.stringify({ path: target, entries }, null, 2);
      }

      // ── Memory & Knowledge Layer ──────────────────────────────────
      case "ghoststack_memory_stats": {
        const stats = await this.ctx.memoryStore.getStats();
        return JSON.stringify(stats, null, 2);
      }
      case "ghoststack_memory_store": {
        const id = await this.ctx.memoryStore.store({
          type:
            (args.type as
              | "observation"
              | "decision"
              | "result"
              | "error"
              | "state"
              | "knowledge") ?? "knowledge",
          key: args.key as string,
          value: args.value,
          tags: (args.tags as string[]) || [],
          agentId: args.agentId as string,
          workflowId: args.workflowId as string,
        });
        return JSON.stringify({ id }, null, 2);
      }
      case "ghoststack_memory_query": {
        const result = await this.ctx.memoryStore.query({
          types: args.types as (
            | "observation"
            | "decision"
            | "result"
            | "error"
            | "state"
            | "knowledge"
          )[],
          keyPrefix: args.keyPrefix as string,
          tags: args.tags as string[],
          limit: (args.limit as number) || 20,
        });
        return JSON.stringify(
          {
            total: result.total,
            entries: result.entries.map((e) => ({
              id: e.id,
              type: e.type,
              key: e.key,
              agentId: e.agentId,
              tags: e.tags,
              timestamp: e.timestamp.toISOString(),
            })),
          },
          null,
          2,
        );
      }

      // ── Agent Bus ──────────────────────────────────────────────────
      case "ghoststack_agent_capabilities": {
        const caps = await this.ctx.agentBus.getCapabilities();
        return JSON.stringify(caps, null, 2);
      }
      case "ghoststack_agent_send": {
        const msgId = await this.ctx.agentBus.send({
          from: args.from as string,
          to: args.to as string,
          type:
            (args.type as
              | "result"
              | "error"
              | "request"
              | "response"
              | "broadcast"
              | "delegation") ?? "broadcast",
          subject: args.subject as string,
          body: args.body,
        });
        return JSON.stringify({ messageId: msgId }, null, 2);
      }
      case "ghoststack_agent_find": {
        const agents = await this.ctx.agentBus.findAgents(args.action as string);
        return JSON.stringify(agents, null, 2);
      }

      // ── Circuit Breaker ────────────────────────────────────────────
      case "ghoststack_circuit_state": {
        return JSON.stringify(
          {
            state: this.ctx.circuitBreaker.getState(),
            metrics: this.ctx.circuitBreaker.getMetrics(),
          },
          null,
          2,
        );
      }
      case "ghoststack_circuit_reset": {
        this.ctx.circuitBreaker.reset();
        return JSON.stringify({ reset: true, state: this.ctx.circuitBreaker.getState() }, null, 2);
      }

      // ── Diagnostic Enricher ──────────────────────────────────────────
      case "ghoststack_diagnostics": {
        const diag = this.ctx.diagnosticEnricher.getRichDiagnostics();
        return JSON.stringify(diag, null, 2);
      }
      case "ghoststack_health_history": {
        const history = this.ctx.diagnosticEnricher.getHealthHistory() as unknown as {
          getStats(): unknown;
          getLatest(): unknown;
          getHistory(): unknown[];
        };
        return JSON.stringify(
          {
            stats: history.getStats(),
            latest: history.getLatest(),
            history: history.getHistory().slice(-50),
          },
          null,
          2,
        );
      }

      // ── Runtime Graph ────────────────────────────────────────────────
      case "ghoststack_runtime_graph": {
        if (!this.ctx.runtimeGraph) {
          return JSON.stringify(
            { available: false, message: "RuntimeGraph not initialized" },
            null,
            2,
          );
        }
        const graph = await this.ctx.runtimeGraph.getSnapshot();
        return JSON.stringify(graph, null, 2);
      }
      case "ghoststack_floci_extended": {
        const action = args.action as string;
        if (!action) throw new Error("action is required for extended Floci ops");
        if (!EXTENDED_FLOCI_ACTIONS.includes(action)) {
          throw new Error(
            `Unknown extended Floci action: ${action}. Valid: ${EXTENDED_FLOCI_ACTIONS.join(", ")}`,
          );
        }
        const endpoint = resolveFlociEndpoint();
        // Thread emitEvent so S3 object creation events propagate through the event bus
        const result = await dispatchExtendedAction(
          endpoint,
          action,
          args,
          async (event, payload) => {
            await this.ctx.eventBus.publish(event, payload);
          },
        );
        return JSON.stringify(result, null, 2);
      }

      default:
        throw new Error(`Unknown GhostStack MCP tool: ${name}`);
    }
  }
}

export async function registerGhostStackMcpBridge(ctx: GhostStackRuntimeContext): Promise<{
  registry: MCPServerRegistry;
  runtime: MCPRuntime;
}> {
  const registry = new MCPServerRegistry();
  const transport = new GhostStackMcpBridge(ctx);
  await registry.registerServer(
    {
      name: "ghoststack",
      transportType: "stdio",
      endpoint: "in-process",
      status: "active",
      tools: [...GHOSTSTACK_MCP_TOOLS],
    },
    transport,
  );
  const runtime = new MCPRuntime(registry, ctx.metrics, ctx.tracer);
  return { registry, runtime };
}

export const GHOSTSTACK_MCP_TOOLS = [
  "ghoststack_health",
  "ghoststack_runtime_snapshot",
  "ghoststack_list_workflows",
  "ghoststack_load_spec",
  "ghoststack_execute_workflow",
  "ghoststack_workflow_cancel",
  "ghoststack_workflow_resume",
  "ghoststack_workflow_checkpoints",
  "ghoststack_workflow_replay",
  "ghoststack_run_e2e",
  "ghoststack_floci_execute",
  "ghoststack_sandbox_write",
  "ghoststack_sandbox_read",
  "ghoststack_sandbox_list",
  // Memory & Knowledge Layer
  "ghoststack_memory_stats",
  "ghoststack_memory_store",
  "ghoststack_memory_query",
  // Agent Bus
  "ghoststack_agent_capabilities",
  "ghoststack_agent_send",
  "ghoststack_agent_find",
  // Circuit Breaker
  "ghoststack_circuit_state",
  "ghoststack_circuit_reset",
  // Extended Floci Operations
  "ghoststack_floci_extended",
  // Diagnostics
  "ghoststack_diagnostics",
  "ghoststack_health_history",
  // Runtime Graph
  "ghoststack_runtime_graph",
];
