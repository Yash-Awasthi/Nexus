#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Conductor operator CLI (`gs` / `conductor`)
 */
import * as fs from "fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "path";

const _require = createRequire(import.meta.url);

import {
  ADAPTER_MANIFEST,
  FederationSupervisor,
  PlanningEngine,
  bootstrap,
  createGhostStackServer,
  createRuntimeContext,
  loadGhostStackConfig,
  runFederationE2e,
  runHealthcheck,
  specToWorkflowDefinition,
  startRuntime,
  stopRuntime,
} from "@nexus/runtime";
import type { ITaskSynthesisResult, QueueJob } from "@nexus/runtime";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function usage(): void {
  console.log(`GhostStack CLI

Usage: gs <command> [options]

Commands:
  init                 Scaffold config + folders + example specs (setup wizard)
  start                Start HTTP API server (foreground)
  start:federation     Start Floci (Docker) + API + optional MCP server
  stop                 Stop federation resources (Docker Floci if we started it)
  restart              Restart federation services (stop, wait, start)
  ps                   List running federation services in a premium layout
  bootstrap            Initialize runtime (--showcase for demo workflows)
  status               Federation + Floci + API health snapshot
  health               Alias for status
  e2e                  Run federation E2E (S3 → Lambda → invoke); needs live Floci
  e2e:http             Run E2E against running API (GHOSTSTACK_API_URL)
  adapters             List vendored adapter manifest
  diagnose             Config + healthcheck + federation status
  workflows            List registered workflow definitions
  workflows:executions List workflow execution history and telemetry stats
  workflows:templates  List registered workflow templates
  approve <id>         Approve a pending workflow execution
  cancel <id>          Cancel a running workflow execution
  logs [limit]         Show recent event log entries (default 20)
  events [limit]       Alias for logs
  memory               Query memory store entries and stats
  graph                Show RuntimeGraph topology snapshot
  graph:nodes          List all nodes in RuntimeGraph
  graph:edges          List all edges in RuntimeGraph
  graph:prune          Remove stale/failed nodes from RuntimeGraph
  graph:validate       Validate RuntimeGraph integrity (cycles, dangling edges, missing deps)
  graph:repair         Repair RuntimeGraph integrity (remove dangling edges, fix deps)
  workflows:idempotency  List idempotency tokens for duplicate-safe execution tracking
  workflows:verify <id>  Verify workflow execution state integrity (checkpoint vs telemetry)
  plan <objective>     Generate a governed execution plan from a natural-language objective
  queue                Show current executor queue state (pending + dead-letter jobs)
  dlq list             List all dead-letter queue entries
  dlq retry <job-id>   Re-enqueue a specific dead-letter job (resets retry count)
  dlq clear            Purge all dead-letter queue entries
  run <spec-path>      Load a workflow spec file, register, and execute it immediately
  submit <objective>   Plan + govern + execute a natural-language objective end-to-end
  version              Print GhostStack version and runtime info
  help                 Show this help

Config: conductor.config.json + .env (see conductor.config.example.json)
`);
}

async function cmdInit(): Promise<void> {
  console.log("\n=================== GhostStack Developer Init Wizard ===================");
  console.log("Scaffolding local spec-driven cloud lab environment...\n");

  const dataDir = path.join(repoRoot, "data-runtime");
  const specsDir = path.join(repoRoot, "specs");
  const demoSpecsDir = path.join(specsDir, "demo-etl");

  // Create runtime dirs
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`[scaffold] Created runtime data directory: ${dataDir}`);
  }
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
    console.log(`[scaffold] Created workflow specs directory: ${specsDir}`);
  }
  if (!fs.existsSync(demoSpecsDir)) {
    fs.mkdirSync(demoSpecsDir, { recursive: true });
    console.log(`[scaffold] Created demo specs directory: ${demoSpecsDir}`);
  }

  // Create conductor.config.json if not exists (wx flag = exclusive create, avoids TOCTOU)
  const configPath = path.join(repoRoot, "conductor.config.json");
  try {
    const defaultConfig = {
      apiPort: 3000,
      flociUrl: "http://localhost:4566",
      mcpPort: 8100,
      dataDir: "./data-runtime",
      features: {
        flociAutostart: true,
        flociStrict: false,
        offlineMode: true,
        mcpBridge: true,
        mcpExternal: true,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), {
      flag: "wx",
      encoding: "utf8",
    });
    console.log(`[scaffold] Created default config file: ${configPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Create .env if not exists (exclusive create to avoid TOCTOU race)
  const envPath = path.join(repoRoot, ".env");
  const envExamplePath = path.join(repoRoot, ".env.example");
  try {
    // Attempt exclusive open — throws EEXIST if file already present
    const fd = fs.openSync(envPath, "wx");
    fs.closeSync(fd);
    // File didn't exist — populate it
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log(`[scaffold] Copied .env from .env.example`);
    } else {
      const defaultEnv = `GHOSTSTACK_API_PORT=3000
GHOSTSTACK_FLOCI_URL=http://localhost:4566
GHOSTSTACK_MCP_PORT=8100
GHOSTSTACK_DATA_DIR=./data-runtime
GHOSTSTACK_FLOCI_AUTOSTART=true
GHOSTSTACK_FLOCI_STRICT=false
GHOSTSTACK_OFFLINE_MODE=true
GHOSTSTACK_MCP_BRIDGE=true
GHOSTSTACK_MCP_EXTERNAL=true
`;
      fs.writeFileSync(envPath, defaultEnv, "utf8");
      console.log(`[scaffold] Created default .env file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Create example spec if not exists (exclusive create to avoid TOCTOU race)
  const specPath = path.join(demoSpecsDir, "workflow-spec.json");
  try {
    fs.writeFileSync(specPath, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if (!fs.readFileSync(specPath, "utf8").trim()) {
    const demoSpec = {
      spec_version: "v1.1",
      metadata: {
        name: "Demo ETL Pipeline",
        description:
          "Scrapes news articles, transforms key headers, and stores in local Floci S3 buckets.",
        author: "GhostStack Operator",
      },
      template_id: "governed-etl-template",
      tasks: [
        {
          id: "extract-news",
          title: "Scrape HN news frontpage",
          description: "Scrapes Hacker News title metrics",
          type: "scraping",
          action: "scrape_url",
          priority: "high",
          arguments: {
            url: "https://news.ycombinator.com",
            maxLengthBytes: 40000,
            selectors: ["a.storylink"],
          },
          dependencies: [],
        },
        {
          id: "transform-news",
          title: "Filter and match tech headers",
          description: "Runs custom regex transforms on news tags",
          type: "floci",
          action: "filter_content",
          priority: "medium",
          arguments: {
            pattern: "(?:AI|Rust|TypeScript|Cognitive)",
            sourceTaskId: "extract-news",
          },
          dependencies: ["extract-news"],
        },
        {
          id: "load-archive",
          title: "Create persistent storage node",
          description: "Ingests transformed artifacts into Floci S3",
          type: "floci",
          action: "create_s3_bucket",
          priority: "medium",
          arguments: {
            bucketName: "conductor-tech-archive",
            sourceTaskId: "transform-news",
          },
          dependencies: ["transform-news"],
        },
      ],
    };
    fs.writeFileSync(specPath, JSON.stringify(demoSpec, null, 2), "utf8");
    console.log(`[scaffold] Scaffolding example spec: ${specPath}`);
  }

  console.log("\n=======================================================================");
  console.log("  GHOSTSTACK SCAFFOLDING & INITIALIZATION COMPLETE");
  console.log("  Run 'gs start:federation' to boot your local autonomous cloud lab!");
  console.log("=======================================================================\n");
}

async function cmdPs(): Promise<void> {
  const config = loadGhostStackConfig(repoRoot);
  const supervisor = new FederationSupervisor(repoRoot, config);
  const status = await supervisor.status();

  console.log("\n======================== GhostStack Federation ========================");
  console.log(`  Mode:     ${status.mode.toUpperCase()}`);
  console.log(`  Status:   ${status.status.toUpperCase()}`);
  if (status.startedAt) {
    console.log(`  Started:  ${new Date(status.startedAt).toLocaleString()}`);
    console.log(`  Uptime:   ${status.uptimeSeconds} seconds`);
  }
  console.log("-----------------------------------------------------------------------");
  console.log("  SERVICE       STATUS       PORT     PID       DETAILS / LATENCY");
  console.log("-----------------------------------------------------------------------");
  for (const s of status.services) {
    const name = s.name.padEnd(13);
    const stat = s.status.toUpperCase().padEnd(12);
    const port = (s.port ? String(s.port) : "-").padEnd(8);
    const pid = (s.pid ? String(s.pid) : "-").padEnd(9);
    const detail = s.latencyMs ? `${s.latencyMs}ms` : s.detail || "-";
    console.log(`  ${name}${stat}${port}${pid}${detail}`);
  }
  console.log("=======================================================================\n");
}

async function cmdStatus(): Promise<void> {
  const config = loadGhostStackConfig(repoRoot);
  const supervisor = new FederationSupervisor(repoRoot, config);
  const status = await supervisor.status();
  const persisted = await FederationSupervisor.readPersistedStatus(repoRoot);
  console.log(JSON.stringify({ config, live: status, persisted }, null, 2));
}

async function cmdDiagnose(): Promise<void> {
  const config = loadGhostStackConfig(repoRoot);
  console.log("=== GhostStack diagnose ===\n");
  console.log("Config:", JSON.stringify(config, null, 2));
  await cmdStatus();
  console.log("\n=== Healthcheck ===\n");
  runHealthcheck();
}

async function cmdE2e(viaHttp: boolean): Promise<void> {
  process.env.GHOSTSTACK_FLOCI_STRICT = "true";
  process.env.GHOSTSTACK_OFFLINE_MODE = "false";
  process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK = "false";

  if (viaHttp) {
    const api = process.env.GHOSTSTACK_API_URL ?? "http://127.0.0.1:3000";
    const res = await fetch(`${api}/runtime/e2e/federation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strict: true, cleanup: true }),
    });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const result = await runFederationE2e(ctx, { strict: true, cleanup: true });
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exit(1);
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdStart(federation: boolean): Promise<void> {
  loadGhostStackConfig(repoRoot);
  if (federation) {
    const supervisor = new FederationSupervisor(repoRoot);
    await supervisor.start();
    await new Promise<void>(() => {
      /* SIGINT/SIGTERM handled by supervisor */
    });
    return;
  }
  const gs = await createGhostStackServer(repoRoot);
  console.log(`[GhostStack] API http://127.0.0.1:${gs.port}`);
  const shutdown = async () => {
    await gs.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

async function cmdStop(): Promise<void> {
  loadGhostStackConfig(repoRoot);
  const supervisor = new FederationSupervisor(repoRoot);
  await supervisor.stop();
}

async function cmdRestart(): Promise<void> {
  console.log("[gs] Restarting GhostStack federation...");
  await cmdStop();
  await new Promise((r) => setTimeout(r, 1500));
  await cmdStart(true);
}

async function cmdWorkflowsList(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const workflows = ctx.inspector.getWorkflowsList();
    console.log("\n======================== GhostStack Workflows ========================");
    if (workflows.length === 0) {
      console.log("  (no workflows registered)");
    } else {
      for (const w of workflows) {
        const _w = w as Record<string, unknown>;
        console.log(`  ${_w.id}`);
        console.log(`    Name:        ${_w.name}`);
        console.log(`    Description: ${_w.description}`);
        console.log(`    Tasks:       ${_w.tasksCount}`);
        console.log("");
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdWorkflowsExecutions(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const stats = ctx.inspector.getWorkflowTelemetryStats() as Record<string, unknown>;
    const executions = ctx.inspector.getWorkflowExecutionHistory();
    console.log("\n======================== Workflow Executions ========================");
    console.log(`  Total:    ${stats.totalExecutions}`);
    console.log(`  Succeeded: ${stats.succeededCount}`);
    console.log(`  Failed:   ${stats.failedCount}`);
    console.log(`  Rejected: ${stats.rejectedCount}`);
    console.log(`  Pending:  ${stats.pendingCount}`);
    console.log("-----------------------------------------------------------------------");
    if (executions.length === 0) {
      console.log("  (no executions)");
    } else {
      for (const e of executions.slice(-20).reverse()) {
        const _e = e as Record<string, unknown>;
        const status = (_e.status as string).padEnd(12);
        const id = (_e.id as string).padEnd(28);
        const started = _e.startedAt ? new Date(_e.startedAt as string).toLocaleTimeString() : "-";
        const note = _e.error
          ? ` ERR: ${_e.error}`
          : _e.approved === false
            ? " (pending approval)"
            : "";
        console.log(`  ${status}${id}${started}${note}`);
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdWorkflowsTemplates(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const templates = ctx.inspector.getWorkflowTemplates();
    console.log("\n======================== Workflow Templates =========================");
    if (templates.length === 0) {
      console.log("  (no templates registered)");
    } else {
      for (const t of templates) {
        const _t = t as Record<string, unknown>;
        console.log(`  ${_t.templateId}`);
        console.log(`    Name:        ${_t.name}`);
        console.log(`    Description: ${_t.description}`);
        console.log("");
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdApprove(approvalId: string | undefined): Promise<void> {
  if (!approvalId) {
    console.error("Usage: gs approve <approval-id>");
    console.error("  Use 'gs workflows:executions' to list pending executions with IDs");
    process.exit(1);
  }
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const result = await ctx.workflowEngine.approveAndTriggerWorkflow(approvalId);
    console.log(`\n=== Approval Result ===`);
    console.log(`  Execution: ${result.id}`);
    console.log(`  Workflow:  ${result.workflowId}`);
    console.log(`  Status:    ${result.status.toUpperCase()}`);
    if (result.error) console.error(`  Error:     ${result.error}`);
    console.log("");
  } catch (err) {
    console.error(`Approval failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdCancel(executionId: string | undefined): Promise<void> {
  if (!executionId) {
    console.error("Usage: gs cancel <execution-id>");
    process.exit(1);
  }
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const result = ctx.workflowEngine.cancelExecution(executionId);
    if (result) {
      console.log(`\n=== Cancellation Result ===`);
      console.log(`  Execution: ${result.id}`);
      console.log(`  Status:    ${result.status.toUpperCase()}`);
      if (result.error) console.log(`  Reason:    ${result.error}`);
    } else {
      console.log(`No active execution found: ${executionId}`);
      process.exit(1);
    }
    console.log("");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdLogs(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const events = await ctx.inspector.getEvents();
    console.log("\n======================== Event Log ================================");
    const limit = parseInt(process.argv[4] || "20", 10);
    const slice = events.slice(-limit).reverse();
    if (slice.length === 0) {
      console.log("  (no events recorded)");
    } else {
      for (const e of slice) {
        const ts = e.timestamp ? new Date(e.timestamp).toISOString() : "-";
        const eventName = (e.event || "?").padEnd(40);
        console.log(`  ${eventName} ${ts}`);
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdGraph(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const snapshot = await ctx.runtimeGraph.getSnapshot();
    console.log("\n======================== Runtime Graph =============================");
    console.log(`  Total Nodes: ${snapshot.summary.totalNodes}`);
    console.log(`  Total Edges: ${snapshot.edges.length}`);
    console.log("  By Type:");
    for (const [type, count] of Object.entries(snapshot.summary.byType)) {
      console.log(`    ${type.padEnd(25)} ${count}`);
    }
    console.log("  By Status:");
    for (const [status, count] of Object.entries(snapshot.summary.byStatus)) {
      console.log(`    ${status.padEnd(25)} ${count}`);
    }
    console.log(`\n  Nodes (${snapshot.nodes.length}):`);
    for (const node of snapshot.nodes) {
      const status = node.status.padEnd(10);
      const type = node.type.padEnd(25);
      console.log(`    [${status}] ${type} ${node.name}`);
    }
    if (snapshot.edges.length > 0) {
      console.log(`\n  Edges (${snapshot.edges.length}):`);
      for (const edge of snapshot.edges) {
        console.log(`    ${edge.from} --[${edge.relationship}]--> ${edge.to}`);
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdGraphNodes(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const snapshot = await ctx.runtimeGraph.getSnapshot();
    console.log("\n======================== RuntimeGraph Nodes =========================");
    console.log(`  Total: ${snapshot.nodes.length}\n`);
    for (const node of snapshot.nodes) {
      console.log(`  Node: ${node.id}`);
      console.log(`    Name:     ${node.name}`);
      console.log(`    Type:     ${node.type}`);
      console.log(`    Status:   ${node.status}`);
      console.log(`    Created:  ${node.createdAt.toISOString()}`);
      console.log(`    Updated:  ${node.updatedAt.toISOString()}`);
      if (node.dependencies.length > 0) {
        console.log(`    Depends on: ${node.dependencies.join(", ")}`);
      }
      console.log("");
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdGraphEdges(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const snapshot = await ctx.runtimeGraph.getSnapshot();
    console.log("\n======================== RuntimeGraph Edges =========================");
    console.log(`  Total: ${snapshot.edges.length}\n`);
    if (snapshot.edges.length === 0) {
      console.log("  (no edges registered)");
    } else {
      for (const edge of snapshot.edges) {
        console.log(`  ${edge.from}`);
        console.log(`    └──[${edge.relationship}]──> ${edge.to}`);
        if (edge.metadata) {
          console.log(`    Metadata: ${JSON.stringify(edge.metadata)}`);
        }
        console.log("");
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdGraphValidate(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const report = await ctx.runtimeGraph.validate();
    console.log("\n======================== RuntimeGraph Validation ====================");
    console.log(`  Valid:        ${report.valid ? "✅ YES" : "❌ NO"}`);
    console.log(`  Nodes:        ${report.nodeCount}`);
    console.log(`  Edges:        ${report.edgeCount}`);
    console.log(`  Dangling edges: ${report.danglingEdgeCount}`);
    console.log(`  Missing deps:  ${report.missingDependencyCount}`);
    console.log(`  Cycles:        ${report.cycleCount}`);
    console.log(`  Desync edges:  ${report.desyncedEdgeCount}`);
    if (report.cycleList.length > 0) {
      console.log("\n  Cycles detected:");
      for (const cycle of report.cycleList) {
        console.log(`    ${cycle.join(" → ")}`);
      }
    }
    if (report.danglingEdgeList.length > 0) {
      console.log("\n  Dangling edges:");
      for (const de of report.danglingEdgeList) {
        console.log(`    ${de.from} --[${de.relationship}]--> ${de.to} (target missing)`);
      }
    }
    if (report.missingDependencyList.length > 0) {
      console.log("\n  Missing dependencies:");
      for (const md of report.missingDependencyList) {
        console.log(`    Node ${md.nodeId} references missing dep: ${md.missingDepId}`);
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdGraphRepair(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    console.log("\n=== RuntimeGraph Repair ===");
    const before = await ctx.runtimeGraph.validate();
    console.log(
      `  Before: valid=${before.valid}, dangling=${before.danglingEdgeCount}, missingDeps=${before.missingDependencyCount}, cycles=${before.cycleCount}`,
    );
    const after = await ctx.runtimeGraph.repair();
    console.log(
      `  After:  valid=${after.valid}, dangling=${after.danglingEdgeCount}, missingDeps=${after.missingDependencyCount}, cycles=${after.cycleCount}`,
    );
    console.log(`  Repaired: ${after.repaired ? "✅" : "already clean"}`);
    if (after.warnings.length > 0) {
      console.log("\n  Warnings:");
      for (const w of after.warnings) {
        console.log(`    ⚠ ${w}`);
      }
    }
    console.log("\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdWorkflowsIdempotency(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const tokens = ctx.workflowEngine.listIdempotencyTokens();
    console.log("\n======================== Idempotency Tokens ========================");
    if (tokens.length === 0) {
      console.log("  (no idempotency tokens registered)");
    } else {
      console.log(`  Total: ${tokens.length}\n`);
      for (const t of tokens) {
        console.log(`  Token:        ${t.token}`);
        console.log(`  Execution ID: ${t.executionId}`);
        console.log(`  Workflow ID:  ${t.workflowId}`);
        console.log(`  Status:       ${t.result.status}`);
        console.log(`  Created:      ${t.timestamp.toISOString()}`);
        console.log("");
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdWorkflowsVerifyState(): Promise<void> {
  const executionId = process.argv[3];
  if (!executionId) {
    console.error("Usage: gs workflows:verify <execution-id>");
    process.exit(1);
  }
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const result = await ctx.workflowEngine.verifyState(executionId);
    console.log("\n======================== State Verification ========================");
    console.log(`  Execution: ${executionId}`);
    console.log(`  Valid:      ${result.valid ? "✅" : "❌"}`);
    if (result.issues.length > 0) {
      console.log("\n  Issues:");
      for (const issue of result.issues) {
        console.log(`    ❌ ${issue}`);
      }
    } else {
      console.log("  No issues found.");
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdGraphPrune(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const snapshot = await ctx.runtimeGraph.getSnapshot();
    const staleIds: string[] = [];
    for (const node of snapshot.nodes) {
      if (node.status === "removed" || node.status === "failed") {
        staleIds.push(node.id);
      }
    }
    console.log(`\n=== RuntimeGraph Prune ===`);
    console.log(`  Found ${staleIds.length} stale nodes to remove.`);
    let removed = 0;
    for (const id of staleIds) {
      await ctx.runtimeGraph.removeNode(id);
      removed++;
      console.log(`  Removed: ${id}`);
    }
    // Repair the graph to clean up dangling dependency references in remaining nodes
    if (removed > 0) {
      const repairReport = await ctx.runtimeGraph.repair();
      console.log(
        `  Repair: removed ${repairReport.danglingEdgeCount} dangling edge(s), ${repairReport.missingDependencyCount} missing dep(s)`,
      );
    }
    console.log(`\n  Done: ${removed} node(s) pruned.`);
    if (removed === 0) {
      console.log("  No stale nodes found.");
    }
    console.log("\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdMemory(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const stats = (await ctx.inspector.getMemoryStats()) as Record<string, unknown>;
    console.log("\n======================== Memory Store ==============================");
    console.log(`  Available: ${stats.available}`);
    if (stats.available) {
      console.log(`  Total entries: ${stats.totalEntries}`);
      console.log(`  By type:       ${JSON.stringify(stats.byType || {})}`);
      console.log(`  Oldest:        ${stats.oldest || "-"}`);
      console.log(`  Newest:        ${stats.newest || "-"}`);

      const entries = await ctx.inspector.getMemoryEntries({ limit: 20 });
      if (entries.length > 0) {
        console.log("");
        console.log("  Recent entries:");
        for (const e of entries) {
          const _e = e as Record<string, unknown>;
          console.log(`    [${_e.type}] ${_e.key} @ ${_e.timestamp}`);
        }
      }
    }
    console.log("=======================================================================\n");
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdVersion(): Promise<void> {
  let version = "unknown";
  const nodeVersion = process.versions.node;
  try {
    version = (_require("../package.json") as { version: string }).version;
  } catch {
    // ignore
  }
  console.log(`\nGhostStack v${version}`);
  console.log(`Node.js  ${nodeVersion}`);
  console.log(`Platform ${process.platform} / ${process.arch}`);
  console.log(`PID      ${process.pid}\n`);
}

async function cmdPlan(objective: string | undefined): Promise<void> {
  if (!objective || objective.trim() === "") {
    console.error("Usage: gs plan <objective>");
    console.error(`  Example: gs plan "deploy ingestion pipeline bucketName=my-data"`);
    process.exit(1);
  }

  const engine = new PlanningEngine();
  const plan = await engine.generatePlan(objective);
  const total = plan.synthesisResults.reduce(
    (sum: number, t: ITaskSynthesisResult) => sum + (t.governanceMetadata?.costEstimate ?? 0),
    0,
  );

  console.log(`\n======================== Generated Plan ============================`);
  console.log(`  Plan ID:   ${plan.planId}`);
  console.log(`  Objective: ${plan.objective}`);
  console.log(`  Tasks:     ${plan.synthesisResults.length}`);
  console.log(`  Est. cost: $${total.toFixed(4)}`);
  console.log(`  Generated: ${plan.timestamp.toISOString()}`);
  console.log(`----------------------------------------------------------------------`);

  for (let i = 0; i < plan.synthesisResults.length; i++) {
    const t = plan.synthesisResults[i]!;
    const priority = `[${t.priority.toUpperCase().padEnd(6)}]`;
    const deps = t.dependencies.length > 0 ? `deps: ${t.dependencies.join(", ")}` : "deps: none";
    const dangerous = t.governanceMetadata?.dangerous ? " ⚠ DANGEROUS" : "";
    console.log(`\n  #${i + 1}  ${t.action}  ${priority}  ${deps}${dangerous}`);
    console.log(
      `       cost: $${(t.governanceMetadata?.costEstimate ?? 0).toFixed(4)}  scope: ${t.governanceMetadata?.resourceScope}`,
    );
    if (Object.keys(t.arguments).length > 0) {
      console.log(`       args: ${JSON.stringify(t.arguments)}`);
    }
    console.log(`       id:   ${t.taskId}`);
  }

  console.log(`\n======================================================================`);
  if (plan.synthesisResults.some((t: ITaskSynthesisResult) => t.governanceMetadata?.dangerous)) {
    console.log(`  ⚠  Plan contains dangerous operations — governance approval required.`);
  }
  console.log(`\n`);
}

async function cmdQueue(): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);
  try {
    const active = (await ctx.queue?.getActiveJobs?.()) ?? [];
    const dlq = (await ctx.queue?.getDeadLetterQueue?.()) ?? [];

    console.log(`\n======================== Queue Status ==============================`);
    console.log(`  Pending:     ${active.length}`);
    console.log(`  Dead letter: ${dlq.length}`);
    console.log(`----------------------------------------------------------------------`);

    if (active.length === 0) {
      console.log("  (queue is empty)");
    } else {
      console.log(`  ${"JOB ID".padEnd(32)} ${"PRIORITY".padEnd(10)} ${"RETRIES".padEnd(8)} TYPE`);
      console.log(`  ${"─".repeat(70)}`);
      for (const job of active) {
        const id = job.id.padEnd(32);
        const pri = (job.priority ?? "?").padEnd(10);
        const retries = `${job.retries}/${job.maxRetries}`.padEnd(8);
        const type = (job.payload as Record<string, unknown>)?.type ?? "?";
        console.log(`  ${id} ${pri} ${retries} ${type}`);
      }
    }

    if (dlq.length > 0) {
      console.log(`\n  Dead-letter jobs:`);
      for (const job of dlq) {
        const id = job.id.padEnd(32);
        const pri = (job.priority ?? "?").padEnd(10);
        console.log(`  ✗ ${id} ${pri} retries: ${job.retries}/${job.maxRetries}`);
      }
    }

    console.log(`======================================================================\n`);
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdDlq(subcommand: string | undefined, jobId?: string): Promise<void> {
  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);

  try {
    const dlq = await ctx.queue.getDeadLetterQueue();

    if (!subcommand || subcommand === "list") {
      console.log(`\n======================== Dead-Letter Queue ==========================`);
      console.log(`  Total: ${dlq.length}`);
      if (dlq.length === 0) {
        console.log("  (empty)");
      } else {
        console.log(
          `\n  ${"JOB ID".padEnd(32)} ${"PRIORITY".padEnd(10)} ${"RETRIES".padEnd(10)} TYPE`,
        );
        console.log(`  ${"─".repeat(65)}`);
        for (const job of dlq) {
          const id = job.id.padEnd(32);
          const pri = (job.priority ?? "?").padEnd(10);
          const retries = `${job.retries}/${job.maxRetries}`.padEnd(10);
          const type = (job.payload as Record<string, unknown>)?.type ?? "?";
          console.log(`  ${id} ${pri} ${retries} ${type}`);
        }
      }
      console.log(`======================================================================\n`);
      return;
    }

    if (subcommand === "retry") {
      if (!jobId) {
        console.error("Usage: gs dlq retry <job-id>");
        process.exit(1);
      }
      const job = dlq.find((j: QueueJob) => j.id === jobId);
      if (!job) {
        console.error(`No DLQ job found with id: ${jobId}`);
        process.exit(1);
      }
      job.retries = 0;
      await ctx.queue.push(job);
      // Remove only this one job from DLQ by clearing and re-adding the rest
      await ctx.queue.clearDeadLetterQueue();
      for (const remaining of dlq.filter((j: QueueJob) => j.id !== jobId)) {
        await ctx.queue.moveToDeadLetter(remaining, "preserved after retry of sibling");
      }
      console.log(`\n  Re-enqueued job ${jobId} (retries reset to 0).\n`);
      return;
    }

    if (subcommand === "clear") {
      await ctx.queue.clearDeadLetterQueue();
      console.log(`\n  Cleared ${dlq.length} dead-letter job(s).\n`);
      return;
    }

    console.error(`Unknown dlq subcommand: ${subcommand}`);
    console.error("  Usage: gs dlq [list|retry <job-id>|clear]");
    process.exit(1);
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdRun(specPath: string | undefined): Promise<void> {
  if (!specPath) {
    console.error("Usage: gs run <spec-path>");
    console.error("  Example: gs run ./specs/demo-etl/workflow-spec.json");
    process.exit(1);
  }

  const absPath = path.resolve(specPath);
  if (!fs.existsSync(absPath)) {
    console.error(`Spec file not found: ${absPath}`);
    process.exit(1);
  }

  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);

  try {
    const rawSpec = JSON.parse(fs.readFileSync(absPath, "utf8"));
    const workflowId = `run-${path.basename(absPath, path.extname(absPath))}-${Date.now()}`;
    const workflowDef = specToWorkflowDefinition(rawSpec, workflowId);
    ctx.registry.registerWorkflow(workflowDef);

    const executionId = `exec-${Date.now()}`;
    console.log(`\n=== gs run: ${absPath}`);
    console.log(`  Workflow:  ${workflowId}`);
    console.log(`  Execution: ${executionId}`);
    console.log(`  Template:  ${rawSpec.template_id ?? "(none)"}`);
    console.log(`  Tasks:     ${rawSpec.tasks?.length ?? 0}\n`);

    const result = await ctx.workflowEngine.executeWorkflow(workflowId, executionId);
    console.log(`  Status:  ${result.status.toUpperCase()}`);
    if (result.error) console.error(`  Error:   ${result.error}`);
    console.log("\n  Done.\n");

    if (result.status !== "succeeded") process.exit(1);
  } finally {
    await stopRuntime(ctx);
  }
}

async function cmdSubmit(objective: string | undefined): Promise<void> {
  if (!objective || objective.trim() === "") {
    console.error("Usage: gs submit <objective>");
    console.error(`  Example: gs submit "ingest data from s3 bucket my-bucket"`);
    process.exit(1);
  }

  const ctx = await createRuntimeContext(repoRoot);
  await startRuntime(ctx);

  try {
    console.log(`\n=== gs submit: "${objective}"\n`);
    const result = await ctx.orchestrator.submitAndRun(objective);
    console.log(`  Allowed:    ${result.allowed}`);
    console.log(`  Plan ID:    ${result.planId}`);
    console.log(`  Processed:  ${result.processed} task(s)`);
    if (!result.allowed && result.reason) {
      console.error(`  Rejected:   ${result.reason}`);
    }
    console.log("\n");

    if (!result.allowed) process.exit(1);
  } finally {
    await stopRuntime(ctx);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case "init":
      await cmdInit();
      break;
    case "start":
      await cmdStart(false);
      break;
    case "start:federation":
      await cmdStart(true);
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "ps":
      await cmdPs();
      break;
    case "bootstrap":
      loadGhostStackConfig(repoRoot);
      if (process.argv.includes("--showcase")) {
        process.env.GHOSTSTACK_BOOTSTRAP_SHOWCASE = "true";
      }
      await bootstrap();
      break;
    case "status":
    case "health":
      loadGhostStackConfig(repoRoot);
      await cmdStatus();
      break;
    case "e2e":
      loadGhostStackConfig(repoRoot);
      await cmdE2e(false);
      break;
    case "e2e:http":
      loadGhostStackConfig(repoRoot);
      await cmdE2e(true);
      break;
    case "workflows":
      await cmdWorkflowsList();
      break;
    case "workflows:executions":
      await cmdWorkflowsExecutions();
      break;
    case "workflows:templates":
      await cmdWorkflowsTemplates();
      break;
    case "approve":
      await cmdApprove(process.argv[3]);
      break;
    case "cancel":
      await cmdCancel(process.argv[3]);
      break;
    case "logs":
    case "events":
      await cmdLogs();
      break;
    case "graph":
      await cmdGraph();
      break;
    case "graph:nodes":
      await cmdGraphNodes();
      break;
    case "graph:edges":
      await cmdGraphEdges();
      break;
    case "graph:prune":
      await cmdGraphPrune();
      break;
    case "graph:validate":
      await cmdGraphValidate();
      break;
    case "graph:repair":
      await cmdGraphRepair();
      break;
    case "workflows:idempotency":
      await cmdWorkflowsIdempotency();
      break;
    case "workflows:verify":
      await cmdWorkflowsVerifyState();
      break;
    case "memory":
      await cmdMemory();
      break;
    case "adapters":
      console.log(JSON.stringify(ADAPTER_MANIFEST, null, 2));
      break;
    case "diagnose":
      loadGhostStackConfig(repoRoot);
      await cmdDiagnose();
      break;
    case "version":
    case "--version":
    case "-v":
      await cmdVersion();
      break;
    case "plan":
      await cmdPlan(process.argv.slice(3).join(" ") || process.argv[3]);
      break;
    case "queue":
      await cmdQueue();
      break;
    case "dlq":
      await cmdDlq(process.argv[3], process.argv[4]);
      break;
    case "run":
      await cmdRun(process.argv[3]);
      break;
    case "submit":
      await cmdSubmit(process.argv.slice(3).join(" ") || process.argv[3]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(new URL(import.meta.url))) {
  main().catch((err) => {
    console.error("[gs] fatal:", err);
    process.exit(1);
  });
}
