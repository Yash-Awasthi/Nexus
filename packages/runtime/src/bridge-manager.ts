// SPDX-License-Identifier: Apache-2.0
/**
 * BridgeManager — manages Python subprocess bridges for native execution capabilities.
 *
 * Each bridge is a FastAPI server on a dedicated localhost port.
 * BridgeManager spawns, monitors, and terminates them as part of the GhostStack lifecycle.
 *
 * Usage:
 *   const mgr = new BridgeManager();
 *   await mgr.start("stealth-browser");   // spawns bridge if not running
 *   const url = mgr.url("stealth-browser"); // "http://localhost:7701"
 *   await mgr.stopAll();
 */

import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { fileURLToPath } from "node:url";
import * as path from "path";

export type BridgeName =
  | "stealth-browser"
  | "scraping"
  | "local-inference"
  | "mcp-server"
  | "floci";

interface BridgeConfig {
  script: string; // relative to runtime/bridges/
  port: number;
  healthPath: string;
}

const BRIDGE_CONFIGS: Record<BridgeName, BridgeConfig> = {
  "stealth-browser": { script: "stealth_browser_bridge.py", port: 7701, healthPath: "/health" },
  scraping: { script: "web_scraping_bridge.py", port: 7702, healthPath: "/health" },
  "local-inference": { script: "local_inference_bridge.py", port: 7703, healthPath: "/health" },
  "mcp-server": { script: "mcp_server_bridge.py", port: 7704, healthPath: "/health" },
  // Floci bridge — translates /_floci/extended/<action> calls to boto3 against the Floci emulator.
  // Floci itself (floci/floci:latest) runs the standard AWS wire protocol on port 4566;
  // this bridge provides the custom HTTP shim that FlociExecutionAdapter expects.
  floci: { script: "floci_bridge.py", port: 4567, healthPath: "/_floci/health" },
};

const BRIDGES_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "bridges");
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_MAX_ATTEMPTS = 20;

export class BridgeManager {
  private processes = new Map<BridgeName, ChildProcess>();
  private started = new Set<BridgeName>();

  /** Start a bridge by name. No-op if already running. */
  async start(name: BridgeName): Promise<void> {
    if (this.started.has(name)) return;

    const cfg = BRIDGE_CONFIGS[name];
    const scriptPath = path.join(BRIDGES_DIR, cfg.script);

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Bridge script not found: ${scriptPath}`);
    }

    const python = process.env.PYTHON_BIN ?? "python3";
    const proc = spawn(python, [scriptPath, "--port", String(cfg.port)], {
      cwd: BRIDGES_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(`[bridge:${name}] ${d.toString().trimEnd()}\n`);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[bridge:${name}] ${d.toString().trimEnd()}\n`);
    });

    proc.on("exit", (code) => {
      this.started.delete(name);
      this.processes.delete(name);
      if (code !== 0 && code !== null) {
        process.stderr.write(`[bridge:${name}] exited with code ${code}\n`);
      }
    });

    this.processes.set(name, proc);
    await this._waitForHealth(name, cfg);
    this.started.add(name);
  }

  /** Get base URL for a bridge (starts it if not running). */
  async url(name: BridgeName): Promise<string> {
    await this.start(name);
    return `http://localhost:${BRIDGE_CONFIGS[name].port}`;
  }

  /** Stop a specific bridge. */
  async stop(name: BridgeName): Promise<void> {
    const proc = this.processes.get(name);
    if (proc) {
      proc.kill("SIGTERM");
      this.processes.delete(name);
      this.started.delete(name);
    }
  }

  /** Stop all running bridges. */
  async stopAll(): Promise<void> {
    for (const name of [...this.started]) {
      await this.stop(name);
    }
  }

  /** Returns true if a bridge is currently running. */
  isRunning(name: BridgeName): boolean {
    return this.started.has(name);
  }

  private async _waitForHealth(name: BridgeName, cfg: BridgeConfig): Promise<void> {
    for (let i = 0; i < HEALTH_CHECK_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
      try {
        const ok = await this._httpGet(`http://localhost:${cfg.port}${cfg.healthPath}`);
        if (ok) return;
      } catch {
        // not ready yet
      }
    }
    throw new Error(
      `Bridge "${name}" did not become healthy after ${HEALTH_CHECK_MAX_ATTEMPTS * HEALTH_CHECK_INTERVAL_MS}ms`,
    );
  }

  private _httpGet(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        resolve(res.statusCode !== undefined && res.statusCode < 400);
        res.resume();
      });
      req.on("error", () => {
        resolve(false);
      });
      req.setTimeout(400, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /** Simple JSON POST helper for bridge callers. */
  static async post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const parsed = new URL(baseUrl + path);
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }
}

/** Singleton bridge manager — shared across the runtime. */
let _instance: BridgeManager | null = null;
export function getBridgeManager(): BridgeManager {
  if (!_instance) _instance = new BridgeManager();
  return _instance;
}
