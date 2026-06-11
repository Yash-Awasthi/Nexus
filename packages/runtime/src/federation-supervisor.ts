import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { probeFlociHealth, resolveFlociEndpoint } from "../orchestration/floci-client";
import { loadGhostStackConfig, GhostStackConfig } from "./ghoststack-config";
import { runDockerCompose } from "./docker-compose-runner";
import { createGhostStackServer, GhostStackServer } from "./ghoststack-server";
import { McpServerHost } from "./adapters/mcp-server-host";
import type { RuntimeGraph } from "../orchestration/runtime-graph";

export type FederationServiceStatus = {
  name: string;
  status: "healthy" | "degraded" | "offline" | "skipped";
  detail?: string;
  latencyMs?: number;
  pid?: number;
  port?: number;
};

export type FederationSupervisorStatus = {
  mode: "federation" | "standalone";
  status: "running" | "stopped" | "degraded";
  startedAt?: string;
  uptimeSeconds?: number;
  apiUrl?: string;
  mcpUrl?: string;
  flociUrl?: string;
  weStartedFlociDocker?: boolean;
  services: FederationServiceStatus[];
};

type PersistedState = {
  startedAt: string;
  weStartedFlociDocker: boolean;
  composeFiles: string[];
  apiPort: number;
  mcpPort: number;
  apiPid?: number;
  mcpPid?: number;
};

const COMPOSE_FEDERATION = ["docker/docker-compose.federation.yaml"];

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Check whether a process is still running by PID.
 *
 * Uses `process.kill(pid, 0)` which sends a no-op signal (signal 0).
 * On success the process exists. On error:
 *   - EPERM  → process exists but we lack permission to signal
 *   - ESRCH  → process does not exist (POSIX)
 *   - EINVAL → process does not exist (Windows fallback in some Node.js versions)
 *   - other  → unknown — we default to `true` (safe assumption)
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e.code === "EPERM") return true;
    if (e.code === "ESRCH") return false;
    if (e.code === "EINVAL") return false;
    // Unknown error — safe default: assume running
    return true;
  }
}

export class FederationSupervisor {
  private readonly repoRoot: string;
  private config: GhostStackConfig;
  private gsServer: GhostStackServer | null = null;
  private mcpHost: McpServerHost | null = null;
  private weStartedFlociDocker = false;
  private startedAt: string | null = null;
  private runtimeGraph: RuntimeGraph | null = null;
  /** Signal handler references for cleanup on stop() — prevents handler accumulation on repeated start() calls */
  private signalHandlers: Array<{ signal: string; handler: () => void }> = [];

  constructor(repoRoot: string, config?: GhostStackConfig) {
    this.repoRoot = repoRoot;
    this.config = config ?? loadGhostStackConfig(repoRoot);
  }

  static statePath(repoRoot: string): string {
    const dataDir = process.env.GHOSTSTACK_DATA_DIR ?? path.join(repoRoot, "data-runtime");
    return path.join(dataDir, "federation-supervisor-state.json");
  }

  static async readPersistedStatus(repoRoot: string): Promise<FederationSupervisorStatus | null> {
    const p = FederationSupervisor.statePath(repoRoot);
    if (!fs.existsSync(p)) return null;
    let state: PersistedState;
    try {
      state = JSON.parse(fs.readFileSync(p, "utf8")) as PersistedState;
    } catch {
      return null;
    }

    const floci = await probeFlociHealth(resolveFlociEndpoint());
    const uptimeSeconds = state.startedAt
      ? Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000)
      : undefined;

    const apiRunning = state.apiPid ? isProcessRunning(state.apiPid) : false;
    const mcpRunning = state.mcpPid ? isProcessRunning(state.mcpPid) : false;

    let overallStatus: "running" | "stopped" | "degraded" = "stopped";
    if (apiRunning && floci.reachable) {
      overallStatus = "running";
    } else if (apiRunning || floci.reachable) {
      overallStatus = "degraded";
    }

    return {
      mode: "federation",
      status: overallStatus,
      startedAt: state.startedAt,
      uptimeSeconds,
      apiUrl: `http://127.0.0.1:${state.apiPort}`,
      mcpUrl: `http://127.0.0.1:${state.mcpPort}/mcp`,
      flociUrl: resolveFlociEndpoint(),
      weStartedFlociDocker: state.weStartedFlociDocker,
      services: [
        {
          name: "floci",
          status: floci.reachable ? "healthy" : "offline",
          latencyMs: floci.latencyMs,
          port: 4566
        },
        {
          name: "orchestrator",
          status: apiRunning ? "healthy" : "offline",
          pid: state.apiPid,
          port: state.apiPort
        },
        {
          name: "mcp-server",
          status: mcpRunning ? "healthy" : "offline",
          pid: state.mcpPid,
          port: state.mcpPort
        }
      ]
    };
  }

  private persistState(apiPid?: number, mcpPid?: number): void {
    const p = FederationSupervisor.statePath(this.repoRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const state: PersistedState = {
      startedAt: this.startedAt!,
      weStartedFlociDocker: this.weStartedFlociDocker,
      composeFiles: COMPOSE_FEDERATION,
      apiPort: this.config.apiPort,
      mcpPort: this.config.mcpPort,
      apiPid,
      mcpPid
    };
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  }

  /** Optionally attach a RuntimeGraph for topology tracking. */
  attachRuntimeGraph(graph: RuntimeGraph): void {
    this.runtimeGraph = graph;
  }

  private async registerServiceNode(
    name: string,
    type: "mcp_server" | "workflow",
    status: "active" | "failed" | "degraded",
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (!this.runtimeGraph) return;
    try {
      await this.runtimeGraph.addNode(`fed:${name}`, type, name, {
        status,
        metadata,
        dependencies: ["ghoststack-runtime"]
      });
    } catch {
      await this.runtimeGraph.updateNodeStatus(`fed:${name}`, status, metadata);
    }
  }

  private clearState(): void {
    const p = FederationSupervisor.statePath(this.repoRoot);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async waitForFloci(timeoutMs = 120000): Promise<FederationServiceStatus> {
    const started = Date.now();
    let retries = 0;
    while (Date.now() - started < timeoutMs) {
      const probe = await probeFlociHealth(resolveFlociEndpoint(), 5000);
      if (probe.reachable) {
        return { name: "floci", status: "healthy", latencyMs: probe.latencyMs, detail: probe.healthPath };
      }
      retries++;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { name: "floci", status: "offline", detail: `timeout waiting for Floci health after ${retries} retries` };
  }

  async startFlociDocker(): Promise<void> {
    const existing = await probeFlociHealth(resolveFlociEndpoint(), 3000);
    if (existing.reachable) {
      console.log("[federation] Floci already reachable — skipping docker start");
      return;
    }

    console.log("[federation] Starting Floci via Docker Compose...");
    const result = await runDockerCompose(this.repoRoot, COMPOSE_FEDERATION, ["up", "-d", "floci"]);
    if (result.code !== 0) {
      throw new Error(`docker compose up failed: ${result.stderr || result.stdout}`);
    }
    this.weStartedFlociDocker = true;
    const flociStatus = await this.waitForFloci();
    if (flociStatus.status !== "healthy") {
      throw new Error(flociStatus.detail ?? "Floci failed to become healthy");
    }
    console.log(`[federation] Floci healthy (${flociStatus.latencyMs}ms)`);
  }

  async start(options?: {
    skipFlociDocker?: boolean;
    skipMcp?: boolean;
    runtimeGraph?: RuntimeGraph;
  }): Promise<FederationSupervisorStatus> {
    // Check if another instance is already running
    const statePath = FederationSupervisor.statePath(this.repoRoot);
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as PersistedState;
        if (state.apiPid && isProcessRunning(state.apiPid)) {
          throw new Error(`GhostStack is already running (API PID: ${state.apiPid}). Stop it first with 'gs stop'`);
        }
      } catch (err: any) {
        if (err.message.includes("GhostStack is already running")) throw err;
        // corrupt state file, we will clear it
        this.clearState();
      }
    }

    // Verify port conflicts
    const apiPortFree = await isPortAvailable(this.config.apiPort);
    if (!apiPortFree) {
      throw new Error(`Port conflict: API port ${this.config.apiPort} is already in use.`);
    }

    if (this.config.features.mcpExternal && !options?.skipMcp) {
      const mcpPortFree = await isPortAvailable(this.config.mcpPort);
      if (!mcpPortFree) {
        throw new Error(`Port conflict: MCP port ${this.config.mcpPort} is already in use.`);
      }
    }

    if (options?.runtimeGraph) {
      this.runtimeGraph = options.runtimeGraph;
    }

    this.startedAt = new Date().toISOString();
    const services: FederationServiceStatus[] = [];

    process.env.GHOSTSTACK_FLOCI_STRICT = String(this.config.features.flociStrict);
    process.env.GHOSTSTACK_OFFLINE_MODE = String(this.config.features.offlineMode);
    if (this.config.features.flociStrict) {
      process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK = "false";
    }

    // 1. Dependency ordering: Floci first
    if (this.config.features.flociAutostart && !options?.skipFlociDocker) {
      try {
        await this.startFlociDocker();
        services.push({ name: "floci", status: "healthy", port: 4566 });
      } catch (err) {
        services.push({ name: "floci", status: "offline", detail: (err as Error).message });
        throw err;
      }
    } else {
      const probe = await probeFlociHealth(resolveFlociEndpoint());
      services.push({
        name: "floci",
        status: probe.reachable ? "healthy" : "degraded",
        detail: probe.reachable ? undefined : "autostart disabled or unreachable",
        latencyMs: probe.latencyMs,
        port: 4566
      });
    }

    // 2. Orchestrator API next
    this.gsServer = await createGhostStackServer(this.repoRoot);
    services.push({
      name: "orchestrator",
      status: "healthy",
      detail: `http://127.0.0.1:${this.gsServer.port}`,
      pid: process.pid,
      port: this.gsServer.port
    });
    console.log(`[federation] Orchestrator API http://127.0.0.1:${this.gsServer.port}`);

    // 3. MCP composite server last
    this.registerServiceNode("orchestrator-api", "mcp_server", "active", {
      port: this.config.apiPort,
      url: `http://127.0.0.1:${this.config.apiPort}`
    });
    // Register Floci with its actual service status from the services array
    const flociNodeStatus = services.find((s) => s.name === "floci")?.status === "healthy" ? "active" : "degraded";
    this.registerServiceNode("floci-emulator", "mcp_server", flociNodeStatus,
      { endpoint: resolveFlociEndpoint() }
    );

    if (this.config.features.mcpExternal && !options?.skipMcp) {
      this.mcpHost = new McpServerHost({ repoRoot: this.repoRoot });
      try {
        await this.mcpHost.start();
        const mcpPid = this.mcpHost.getPid();
        services.push({
          name: "mcp-server",
          status: "healthy",
          detail: this.mcpHost.getMcpUrl(),
          pid: mcpPid,
          port: this.config.mcpPort
        });
        console.log(`[federation] MCP ${this.mcpHost.getMcpUrl()} (PID: ${mcpPid})`);
      } catch (err) {
        services.push({ name: "mcp-server", status: "skipped", detail: (err as Error).message });
        console.warn("[federation] MCP skipped:", (err as Error).message);
      }
    } else {
      services.push({ name: "mcp-server", status: "skipped", detail: "mcpExternal=false" });
    }

    this.persistState(process.pid, this.mcpHost?.getPid());

    // Setup robust signal handlers — remove previous ones first to avoid accumulation
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    const shutdown = async () => {
      console.log("\n[federation] Received signal, shutting down...");
      await this.stop();
      process.exit(0);
    };
    const sigintHandler = () => void shutdown();
    const sigtermHandler = () => void shutdown();
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);
    this.signalHandlers.push(
      { signal: "SIGINT", handler: sigintHandler },
      { signal: "SIGTERM", handler: sigtermHandler }
    );

    return {
      mode: "federation",
      status: "running",
      startedAt: this.startedAt,
      uptimeSeconds: 0,
      apiUrl: `http://127.0.0.1:${this.config.apiPort}`,
      mcpUrl: this.mcpHost?.getMcpUrl(),
      flociUrl: resolveFlociEndpoint(),
      weStartedFlociDocker: this.weStartedFlociDocker,
      services
    };
  }

  async stop(): Promise<void> {
    console.log("[federation] Initiating graceful shutdown of all services...");

    // Read state first to ensure we know what to stop, especially if running from a different process
    const statePath = FederationSupervisor.statePath(this.repoRoot);
    let weStarted = this.weStartedFlociDocker;
    let apiPid: number | undefined;
    let mcpPid: number | undefined;

    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as PersistedState;
        weStarted = weStarted || state.weStartedFlociDocker;
        apiPid = state.apiPid;
        mcpPid = state.mcpPid;
      } catch {
        // ignore JSON errors
      }
    }

    // 1. Stop MCP in reverse order
    if (this.mcpHost?.isRunning()) {
      console.log("[federation] Stopping MCP host...");
      await this.mcpHost.stop();
    } else if (mcpPid && isProcessRunning(mcpPid)) {
      console.log(`[federation] Killing external MCP process (PID: ${mcpPid})...`);
      try {
        process.kill(mcpPid, "SIGTERM");
      } catch {
        try {
          process.kill(mcpPid, "SIGKILL");
        } catch {
          /* process already exited */
        }
      }
    }

    // 2. Stop Orchestrator API next, allowing event bus and queues to drain
    if (this.gsServer) {
      console.log("[federation] Draining active queues and stopping Orchestrator Server...");
      const ctx = this.gsServer.ctx;
      if (ctx) {
        // Wait briefly for any active tasks to complete/drain
        const queueLength = await ctx.queue.getQueueLength();
        if (queueLength > 0) {
          console.log(`[federation] Queue has ${queueLength} pending jobs. Draining...`);
          let attempts = 0;
          while (await ctx.queue.getQueueLength() > 0 && attempts < 10) {
            await new Promise((r) => setTimeout(r, 200));
            attempts++;
          }
        }
        // Wait for event appendQueue & persistence writeQueue to resolve
        console.log("[federation] Flushing pending events and KV writes to JSONL/JSON...");
        await new Promise((r) => setTimeout(r, 500)); // allow event loops to settle
      }
      await this.gsServer.stop();
      this.gsServer = null;
    } else if (apiPid && apiPid !== process.pid && isProcessRunning(apiPid)) {
      console.log(`[federation] Sending SIGTERM to running orchestrator process (PID: ${apiPid})...`);
      try {
        process.kill(apiPid, "SIGTERM");
        // Give it up to 2 seconds to gracefully exit
        let attempts = 0;
        while (isProcessRunning(apiPid) && attempts < 10) {
          await new Promise((r) => setTimeout(r, 200));
          attempts++;
        }
        if (isProcessRunning(apiPid)) {
          console.log(`[federation] Force-killing unresponsive process (PID: ${apiPid})...`);
          process.kill(apiPid, "SIGKILL");
        }
      } catch {
        /* SIGTERM/SIGKILL failed — process may already be gone */
      }
    }

    // 3. Stop Floci Docker stack last
    if (weStarted) {
      console.log("[federation] Stopping Floci Docker Compose stack...");
      await runDockerCompose(this.repoRoot, COMPOSE_FEDERATION, ["down", "--remove-orphans"]);
    }

    // Remove signal handlers to prevent accumulation
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    this.clearState();
    console.log("[federation] Graceful shutdown complete. Signal handlers cleaned.");
  }

  async status(): Promise<FederationSupervisorStatus> {
    const floci = await probeFlociHealth(resolveFlociEndpoint());
    const services: FederationServiceStatus[] = [
      {
        name: "floci",
        status: floci.reachable ? "healthy" : "offline",
        latencyMs: floci.latencyMs,
        detail: floci.error,
        port: 4566
      }
    ];

    const statePath = FederationSupervisor.statePath(this.repoRoot);
    let apiPid: number | undefined;
    let mcpPid: number | undefined;
    let startedAt: string | undefined;
    let weStartedFlociDocker = this.weStartedFlociDocker;

    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as PersistedState;
        apiPid = state.apiPid;
        mcpPid = state.mcpPid;
        startedAt = state.startedAt;
        weStartedFlociDocker = weStartedFlociDocker || state.weStartedFlociDocker;
      } catch {
        /* corrupt or missing federation state file */
      }
    }

    let apiStatus: FederationServiceStatus = {
      name: "orchestrator",
      status: "offline",
      port: this.config.apiPort,
      pid: apiPid
    };
    try {
      const res = await fetch(`http://127.0.0.1:${this.config.apiPort}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      apiStatus = {
        name: "orchestrator",
        status: res.ok ? "healthy" : "degraded",
        detail: `http://127.0.0.1:${this.config.apiPort}`,
        pid: apiPid,
        port: this.config.apiPort
      };
    } catch {
      apiStatus.detail = "API not reachable";
    }
    services.push(apiStatus);

    const mcpPort = this.config.mcpPort;
    let mcpStatus: FederationServiceStatus = {
      name: "mcp-server",
      status: "offline",
      port: mcpPort,
      pid: mcpPid
    };
    try {
      await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { signal: AbortSignal.timeout(2000) });
      mcpStatus = {
        name: "mcp-server",
        status: "healthy",
        detail: `http://127.0.0.1:${mcpPort}/mcp`,
        pid: mcpPid,
        port: mcpPort
      };
    } catch {
      mcpStatus = { name: "mcp-server", status: "skipped", detail: "not running", pid: mcpPid, port: mcpPort };
    }
    services.push(mcpStatus);

    const uptimeSeconds = startedAt
      ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
      : undefined;

    const apiRunning = apiPid ? isProcessRunning(apiPid) : false;
    let overallStatus: "running" | "stopped" | "degraded" = "stopped";
    if (apiRunning && floci.reachable) {
      overallStatus = "running";
    } else if (apiRunning || floci.reachable) {
      overallStatus = "degraded";
    }

    return {
      mode: this.gsServer || apiRunning ? "federation" : "standalone",
      status: overallStatus,
      startedAt,
      uptimeSeconds,
      apiUrl: `http://127.0.0.1:${this.config.apiPort}`,
      mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      flociUrl: resolveFlociEndpoint(),
      weStartedFlociDocker,
      services
    };
  }

  async runForeground(): Promise<void> {
    await this.start();
    await new Promise<void>(() => {
      /* SIGINT handler calls stop() */
    });
  }
}
