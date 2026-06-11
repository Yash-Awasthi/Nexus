// @ts-nocheck
import * as http from "http";
import * as path from "path";


import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api.js";
import { registerGhostStackMcpBridge } from "../orchestration/ghoststack-mcp-bridge.js";
import type { IExecutionContext } from "../orchestration/interfaces/execution.interface.js";
import { metricsToPrometheus } from "../orchestration/prometheus-format.js";

import { ADAPTER_MANIFEST } from "./adapters/manifest.js";
import { runFederationE2e } from "./e2e-federation.js";
import { createRuntimeContext, startRuntime, stopRuntime } from "./runtime-context.js";
import type { GhostStackRuntimeContext } from "./runtime-context.js";

// ─── Structured health response ──────────────────────────────────────────────

async function buildHealthResponse(ctx: GhostStackRuntimeContext, bootMs: number): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime_ms: number;
  boot_ms: number;
  timestamp: string;
  components: Record<string, { status: string; detail?: string }>;
}> {
  const components: Record<string, { status: string; detail?: string }> = {};

  // Queue
  try {
    const queueLen = await ctx.queue?.getQueueLength?.() ?? 0;
    components.queue = { status: "healthy", detail: `${queueLen} job(s) pending` };
  } catch (e: any) {
    components.queue = { status: "error", detail: e?.message };
  }

  // Floci adapter
  try {
    const flociHealth = ctx.flociAdapter?.getLastHealth?.();
    if (flociHealth?.reachable === false) {
      components.floci = { status: "offline", detail: `latency: ${flociHealth.latencyMs ?? "-"}ms` };
    } else if (flociHealth?.reachable === true) {
      components.floci = { status: "healthy", detail: `latency: ${flociHealth.latencyMs}ms` };
    } else {
      components.floci = { status: "unknown", detail: "not yet probed" };
    }
  } catch (e: any) {
    components.floci = { status: "error", detail: e?.message };
  }

  // Event bus
  try {
    const history = ctx.eventBus?.getHistory?.();
    components.event_bus = {
      status: "healthy",
      detail: `${Array.isArray(history) ? history.length : "?"} event(s) in history`
    };
  } catch (e: any) {
    components.event_bus = { status: "error", detail: e?.message };
  }

  // Workflow engine
  try {
    const wfStats = ctx.inspector?.getWorkflowTelemetryStats?.();
    components.workflow_engine = {
      status: "healthy",
      detail: `${wfStats?.totalExecutions ?? 0} total execution(s)`
    };
  } catch (e: any) {
    components.workflow_engine = { status: "error", detail: e?.message };
  }

  const hasError = Object.values(components).some((c) => c.status === "error" || c.status === "unhealthy");
  const hasDegraded = Object.values(components).some((c) => c.status === "degraded" || c.status === "offline");
  const overall = hasError ? "unhealthy" : hasDegraded ? "degraded" : "healthy";

  // Read version from package.json — resolved relative to the dist or source root
  let version = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version = (require("../package.json") as { version: string }).version;
  } catch {
    // ignore
  }

  return {
    status: overall,
    version,
    uptime_ms: Date.now() - bootMs,
    boot_ms: bootMs,
    timestamp: new Date().toISOString(),
    components
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

export interface GhostStackServer {
  server: http.Server;
  ctx: GhostStackRuntimeContext;
  port: number;
  stop: () => Promise<void>;
}

export async function createGhostStackServer(repoRoot: string): Promise<GhostStackServer> {
  const bootStarted = Date.now();
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);

  if (process.env.GHOSTSTACK_MCP_BRIDGE !== "0") {
    const mcpBridge = await registerGhostStackMcpBridge(ctx);
    const servers = await mcpBridge.registry.listServers();
    ctx.logger.info("GhostStack in-process MCP bridge registered", {
      server: servers[0]?.name,
      tools: servers[0]?.tools
    });
  }

  const diagnosticApi = new RuntimeDiagnosticAPI(ctx.inspector);
  const port = Number(process.env.GHOSTSTACK_API_PORT || "3000");
  const bootMs = bootStarted;
  ctx.metrics.recordTiming("ghoststack.boot_ms", Date.now() - bootStarted);

  const server = http.createServer(async (req, res) => {
    const reqStarted = Date.now();
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    try {
      // ── Health check — always public, no auth required ────────────────────
      if (method === "GET" && (pathname === "/health" || pathname === "/healthz")) {
        const health = await buildHealthResponse(ctx, bootMs);
        res.statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(health, null, 2));
        return;
      }

      if (method === "GET" && pathname === "/metrics/prometheus") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; version=0.0.4");
        res.end(metricsToPrometheus(ctx.metrics.getMetrics()));
        return;
      }

      if (method === "GET" && pathname === "/runtime/adapters") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ manifest: ADAPTER_MANIFEST, floci: ctx.flociAdapter.getLastHealth() }, null, 2)
        );
        return;
      }

      if (method === "GET" && pathname === "/runtime/federation/status") {
        const { FederationSupervisor } = await import("./federation-supervisor.js");
        const status = await FederationSupervisor.readPersistedStatus(repoRoot);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(status ?? { mode: "standalone" }, null, 2));
        return;
      }

      // ── API token auth guard ─────────────────────────────────────────────
      // Set GHOSTSTACK_API_TOKEN to require Bearer token auth on all non-health endpoints.
      const apiToken = process.env.GHOSTSTACK_API_TOKEN;
      if (apiToken && pathname !== "/health" && pathname !== "/healthz") {
        const authHeader = (req.headers.authorization!) ?? "";
        const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (provided !== apiToken) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Unauthorized: invalid or missing API token" }));
          return;
        }
      }

      res.setHeader("Content-Type", "application/json");

      // ── GET /runtime/queue — must be checked before the generic diagnosticApi catch-all ──
      if (method === "GET" && pathname === "/runtime/queue") {
        const [activeJobs, dlqJobs] = await Promise.all([
          ctx.queue.getActiveJobs(),
          ctx.queue.getDeadLetterQueue()
        ]);
        res.statusCode = 200;
        res.end(JSON.stringify({
          activeCount: activeJobs.length,
          dlqCount: dlqJobs.length,
          activeJobs,
          dlqJobs
        }, null, 2));
        return;
      }

      if (method === "GET") {
        const data = await diagnosticApi.handle("GET", pathname);
        res.statusCode = 200;
        res.end(JSON.stringify(data, null, 2));
        ctx.metrics.increment("http.requests", 1);
        return;
      }

      if (method === "POST" && pathname === "/runtime/floci/execute") {
        const bodyRaw = await readBody(req);
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        const action = body.action as string;
        if (!action) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "action is required" }));
          return;
        }
        const payload: Record<string, unknown> = {
          ...((body.payload as Record<string, unknown>) ?? {}),
          ...body
        };
        delete payload.action;
        delete payload.payload;
        const flociCtx: IExecutionContext = {
          taskId: `http-floci-${Date.now()}`,
          startTime: new Date(),
          attempt: 1,
          environment: {},
          logger: ctx.logger
        };
        const result = await ctx.flociAdapter.executeAction(action, payload, flociCtx);
        res.statusCode = 200;
        res.end(JSON.stringify(result, null, 2));
        return;
      }

      if (method === "POST" && pathname === "/runtime/e2e/federation") {
        const bodyRaw = await readBody(req);
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        const result = await runFederationE2e(ctx, {
          strict: body.strict === true,
          cleanup: body.cleanup !== false
        });
        res.statusCode = result.status === "succeeded" ? 200 : 500;
        res.end(JSON.stringify(result, null, 2));
        return;
      }

      if (method === "POST" && pathname === "/runtime/workflows/execute") {
        const bodyRaw = await readBody(req);
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        const workflowId = body.workflowId as string;
        const executionId = (body.executionId as string) || `exec-${Date.now()}`;
        if (!workflowId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "workflowId is required" }));
          return;
        }
        const result = await ctx.workflowEngine.executeWorkflow(workflowId, executionId);
        res.statusCode = 200;
        res.end(JSON.stringify(result, null, 2));
        return;
      }

      if (method === "POST" && pathname.startsWith("/runtime/approvals/") && pathname.endsWith("/approve")) {
        const parts = pathname.split("/");
        const approvalId = parts[parts.length - 2];
        const result = await ctx.workflowEngine.approveAndTriggerWorkflow(approvalId);
        res.statusCode = 200;
        res.end(JSON.stringify(result, null, 2));
        return;
      }

      // ── POST /runtime/plan — plan + governance preview (no execution) ─────────
      if (method === "POST" && pathname === "/runtime/plan") {
        const bodyRaw = await readBody(req);
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        const objective = body.objective as string;
        if (!objective) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "objective is required" }));
          return;
        }
        const plan = await ctx.planningEngine.generatePlan(objective);
        const governanceResult = await ctx.governanceEngine.evaluatePlan(plan);
        res.statusCode = 200;
        res.end(JSON.stringify({ plan, governance: governanceResult }, null, 2));
        return;
      }

      // ── DELETE /runtime/queue/dlq/clear — flush dead-letter queue ─────────────
      if (method === "DELETE" && pathname === "/runtime/queue/dlq/clear") {
        if (typeof (ctx.queue as any).clear === "function") {
          await (ctx.queue as any).clear(true); // includeDlq = true
          res.statusCode = 200;
          res.end(JSON.stringify({ cleared: true }));
        } else {
          res.statusCode = 501;
          res.end(JSON.stringify({ error: "Queue backend does not support clear()" }));
        }
        return;
      }

      res.statusCode = 405;
      res.end(JSON.stringify({ error: `Method not allowed: ${method} ${pathname}` }));
    } catch (err: any) {
      const rawMessage = err?.message || String(err);
      const statusCode = rawMessage.startsWith("Not Found") ? 404 : 500;
      // Avoid exposing internal stack traces / file paths in production responses.
      const safeMessage =
        process.env.NODE_ENV === "production" && statusCode === 500
          ? "Internal server error"
          : rawMessage;
      res.statusCode = statusCode;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: safeMessage }));
      ctx.metrics.increment("http.errors", 1);
    } finally {
      ctx.metrics.recordTiming("http.request_ms", Date.now() - reqStarted, { route: pathname });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => { resolve(); });
  });

  const stop = async () => {
    ctx.logger.info("GhostStack HTTP server stopping");
    await stopRuntime(ctx);
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  };

  return { server, ctx, port, stop };
}

export async function startHttpServer(): Promise<http.Server> {
  const repoRoot = path.resolve(__dirname, "..");
  const { loadGhostStackConfig } = await import("./ghoststack-config.js");
  loadGhostStackConfig(repoRoot);
  const gs = await createGhostStackServer(repoRoot);
  console.log(
    `[GhostStack] API http://127.0.0.1:${gs.port} | /health | POST /runtime/e2e/federation | POST /runtime/workflows/execute`
  );
  const shutdown = async () => {
    await gs.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return gs.server;
}
