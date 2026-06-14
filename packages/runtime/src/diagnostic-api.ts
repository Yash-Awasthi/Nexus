// SPDX-License-Identifier: Apache-2.0
import type { IExtendedRuntimeInspector } from "./runtime-inspector.js";

export class RuntimeDiagnosticAPI {
  private inspector: IExtendedRuntimeInspector;

  constructor(inspector: IExtendedRuntimeInspector) {
    this.inspector = inspector;
  }

  async handle(method: string, path: string): Promise<unknown> {
    if (method !== "GET") {
      throw new Error(`Unsupported method: ${method}`);
    }

    // Dynamic Parameter Route Resolution: /runtime/workflows/:id
    if (path.startsWith("/runtime/workflows/")) {
      const parts = path.split("/");
      const last = parts[parts.length - 1];
      if (last === "replays") {
        return this.inspector.getWorkflowReplays ? this.inspector.getWorkflowReplays() : [];
      }
      if (last === "templates") {
        return this.inspector.getWorkflowTemplates ? this.inspector.getWorkflowTemplates() : [];
      }
      if (last === "telemetry") {
        return this.inspector.getWorkflowTelemetryStats
          ? this.inspector.getWorkflowTelemetryStats()
          : {};
      }
      return this.inspector.getWorkflowExecution
        ? this.inspector.getWorkflowExecution(last!)
        : null;
    }

    switch (path) {
      case "/health":
        return this.inspector.getHealth();
      case "/metrics":
        return this.inspector.getMetrics();
      case "/runtime/state":
        return this.inspector.getSnapshots();
      case "/runtime/tasks":
        return this.inspector.getTasks();
      case "/runtime/events":
        return this.inspector.getEvents();
      case "/runtime/queues":
        return this.inspector.getQueues();
      case "/runtime/services":
        return this.inspector.getServices();
      case "/runtime/snapshots":
        return this.inspector.getSnapshots();
      case "/runtime/mcp":
        return this.inspector.getMCPSummary?.();
      case "/runtime/mcp/servers":
        return this.inspector.getMCPServers?.();
      case "/runtime/mcp/tools":
        return this.inspector.getMCPTools?.();
      case "/runtime/mcp/executions":
        return this.inspector.getMCPExecutions ? this.inspector.getMCPExecutions() : [];

      // Phase 6 Cognitive Governance Endpoints
      case "/runtime/governance":
        return this.inspector.getGovernanceInfo ? this.inspector.getGovernanceInfo() : {};
      case "/runtime/approvals":
        return this.inspector.getApprovalsList ? this.inspector.getApprovalsList() : [];
      case "/runtime/plans":
        return this.inspector.getPlansList?.();
      case "/runtime/guardrails":
        return this.inspector.getGuardrailsInfo ? this.inspector.getGuardrailsInfo() : {};

      // Phase 7 Controlled Execution Subsystem Endpoints
      case "/runtime/browser":
        return this.inspector.getBrowserMetrics ? this.inspector.getBrowserMetrics() : {};
      case "/runtime/scraping":
        return this.inspector.getScrapingMetrics ? this.inspector.getScrapingMetrics() : {};
      case "/runtime/sandbox":
        return this.inspector.getSandboxMetrics ? this.inspector.getSandboxMetrics() : {};
      case "/runtime/environments":
        return this.inspector.getEnvironmentsList ? this.inspector.getEnvironmentsList() : [];

      // Phase 8 Workflow Observability Endpoints
      case "/runtime/workflows":
        return this.inspector.getWorkflowsList ? this.inspector.getWorkflowsList() : [];

      // Memory & Knowledge Layer Endpoints
      case "/runtime/memory":
        return this.inspector.getMemoryStats
          ? this.inspector.getMemoryStats()
          : { available: false };
      case "/runtime/memory/entries":
        return this.inspector.getMemoryEntries
          ? this.inspector.getMemoryEntries({ limit: 50 })
          : [];

      // Agent Bus Endpoints
      case "/runtime/agents":
        return this.inspector.getAgentCapabilities ? this.inspector.getAgentCapabilities() : [];
      case "/runtime/agents/messages":
        return this.inspector.getAgentMessages
          ? this.inspector.getAgentMessages({ limit: 50 })
          : [];

      // Circuit Breaker Endpoints
      case "/runtime/circuits":
        return this.inspector.getCircuitBreakerState
          ? this.inspector.getCircuitBreakerState()
          : { available: false };

      default:
        throw new Error(`Not Found: ${path}`);
    }
  }
}
