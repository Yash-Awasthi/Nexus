import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface McpServerHostOptions {
  repoRoot: string;
  apiUrl?: string;
  mcpPort?: number;
  pythonCommand?: string;
}

/**
 * Manages the optional external MCP Python server (composite federation MCP).
 */
export class McpServerHost {
  private proc: ChildProcess | null = null;
  private readonly scriptPath: string;
  private readonly apiUrl: string;
  private readonly mcpPort: number;
  private readonly python: string;

  constructor(options: McpServerHostOptions) {
    this.scriptPath = path.join(options.repoRoot, "runtime", "mcp", "ghoststack_mcp_server.py");
    this.apiUrl = options.apiUrl ?? process.env.GHOSTSTACK_API_URL ?? "http://127.0.0.1:3000";
    this.mcpPort = options.mcpPort ?? Number(process.env.GHOSTSTACK_MCP_PORT ?? "8100");
    this.python = options.pythonCommand ?? process.env.GHOSTSTACK_PYTHON ?? "python";
  }

  getMcpUrl(): string {
    return `http://127.0.0.1:${this.mcpPort}/mcp`;
  }

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  getPid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`MCP server script not found: ${this.scriptPath}`);
    }

    this.proc = spawn(this.python, [this.scriptPath], {
      cwd: path.dirname(this.scriptPath),
      env: {
        ...process.env,
        GHOSTSTACK_API_URL: this.apiUrl,
        GHOSTSTACK_MCP_PORT: String(this.mcpPort),
        GHOSTSTACK_MCP_TRANSPORT: "streamable-http"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.proc.stdout?.on("data", (d) => process.stdout.write(`[mcp-server] ${d}`));
    this.proc.stderr?.on("data", (d) => process.stderr.write(`[mcp-server] ${d}`));

    await this.waitForPort(this.mcpPort, 15000);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }

  private waitForPort(port: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET", signal: AbortSignal.timeout(1000) });
          resolve();
          return;
        } catch {
          /* not ready */
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`MCP server did not start on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(tick, 400);
      };
      tick();
    });
  }
}
