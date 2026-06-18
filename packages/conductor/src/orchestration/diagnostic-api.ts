import { IRuntimeInspector } from "./interfaces/observability.interface";

export class RuntimeDiagnosticAPI {
  private inspector: IRuntimeInspector;

  constructor(inspector: IRuntimeInspector) {
    this.inspector = inspector;
  }

  async handle(method: string, path: string): Promise<any> {
    if (method !== "GET") {
      throw new Error(`Unsupported method: ${method}`);
    }

    // Dynamic Parameter Route Resolution: /runtime/workflows/:id
    if (path.startsWith("/runtime/workflows/")) {
      const parts = path.split("/");
      const last = parts[parts.length - 1];
      if (last === "replays") {
        return (this.inspector as any).getWorkflowReplays ? (this.inspector as any).getWorkflowReplays() : [];
      }
      if (last === "templates") {
        return (this.inspector as any).getWorkflowTemplates ? (this.inspector as any).getWorkflowTemplates() : [];
      }
      if (last === "telemetry") {
        return (this.inspector as any).getWorkflowTelemetryStats
          ? (this.inspector as any).getWorkflowTelemetryStats()
          : {};
      }
      return (this.inspector as any).getWorkflowExecution ? (this.inspector as any).getWorkflowExecution(last) : null;
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
        return (this.inspector as any).getMCPSummary ? (this.inspector as any).getMCPSummary() : {};
      case "/runtime/mcp/servers":
        return (this.inspector as any).getMCPServers ? (this.inspector as any).getMCPServers() : [];
      case "/runtime/mcp/tools":
        return (this.inspector as any).getMCPTools ? (this.inspector as any).getMCPTools() : [];
      case "/runtime/mcp/executions":
        return (this.inspector as any).getMCPExecutions ? (this.inspector as any).getMCPExecutions() : [];

      // Phase 6 Cognitive Governance Endpoints
      case "/runtime/governance":
        return (this.inspector as any).getGovernanceInfo ? (this.inspector as any).getGovernanceInfo() : {};
      case "/runtime/approvals":
        return (this.inspector as any).getApprovalsList ? (this.inspector as any).getApprovalsList() : [];
      case "/runtime/plans":
        return (this.inspector as any).getPlansList ? (this.inspector as any).getPlansList() : [];
      case "/runtime/guardrails":
        return (this.inspector as any).getGuardrailsInfo ? (this.inspector as any).getGuardrailsInfo() : {};

      // Phase 7 Controlled Execution Subsystem Endpoints
      case "/runtime/browser":
        return (this.inspector as any).getBrowserMetrics ? (this.inspector as any).getBrowserMetrics() : {};
      case "/runtime/scraping":
        return (this.inspector as any).getScrapingMetrics ? (this.inspector as any).getScrapingMetrics() : {};
      case "/runtime/sandbox":
        return (this.inspector as any).getSandboxMetrics ? (this.inspector as any).getSandboxMetrics() : {};
      case "/runtime/environments":
        return (this.inspector as any).getEnvironmentsList ? (this.inspector as any).getEnvironmentsList() : [];

      // Phase 8 Workflow Observability Endpoints
      case "/runtime/workflows":
        return (this.inspector as any).getWorkflowsList ? (this.inspector as any).getWorkflowsList() : [];

      // Memory & Knowledge Layer Endpoints
      case "/runtime/memory":
        return (this.inspector as any).getMemoryStats ? (this.inspector as any).getMemoryStats() : { available: false };
      case "/runtime/memory/entries":
        return (this.inspector as any).getMemoryEntries ? (this.inspector as any).getMemoryEntries({ limit: 50 }) : [];

      // Agent Bus Endpoints
      case "/runtime/agents":
        return (this.inspector as any).getAgentCapabilities ? (this.inspector as any).getAgentCapabilities() : [];
      case "/runtime/agents/messages":
        return (this.inspector as any).getAgentMessages ? (this.inspector as any).getAgentMessages({ limit: 50 }) : [];

      // Circuit Breaker Endpoints
      case "/runtime/circuits":
        return (this.inspector as any).getCircuitBreakerState ? (this.inspector as any).getCircuitBreakerState() : { available: false };

      default:
        throw new Error(`Not Found: ${path}`);
    }
  }
}
