// SPDX-License-Identifier: Apache-2.0
/**
 * Conductor HTTP server — lightweight in-process HTTP gateway used by
 * FederationSupervisor in federation mode. Provides health and queue
 * introspection endpoints without pulling in the full Fastify stack.
 *
 * Routes:
 *   GET  /health            → { status, running, uptimeSeconds, queueLength? }
 *   GET  /v1/queue/length   → { length }  (used by federation drain logic)
 *   *    otherwise          → 404
 *
 * In standalone mode this server is never instantiated.
 */

import * as http from "http";

export interface ConductorServer {
  /** Start the HTTP server and begin listening. */
  start(): Promise<void>;
  /** Gracefully stop the server. */
  stop(): Promise<void>;
  /** The port the server is listening on. */
  readonly port: number;
  /** Whether the server is currently accepting connections. */
  readonly running: boolean;
  /** Optional attached runtime context (federation mode only). */
  ctx?: { queue: { getQueueLength(): Promise<number> }; [key: string]: unknown };
}

class ConductorHttpServer implements ConductorServer {
  private server: http.Server | null = null;
  private _running = false;
  private readonly startedAt = Date.now();
  ctx?: ConductorServer["ctx"];

  constructor(readonly port: number) {}

  get running(): boolean {
    return this._running;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this._handle(req, res);
      });
      this.server.listen(this.port, "127.0.0.1", () => {
        this._running = true;
        resolve();
      });
      this.server.once("error", reject);
    });
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    // ── GET /health ───────────────────────────────────────────────────────────
    if (method === "GET" && url === "/health") {
      const body: Record<string, unknown> = {
        status: "ok",
        server: "conductor",
        running: this._running,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        timestamp: new Date().toISOString(),
      };
      if (this.ctx) {
        body.queueLength = await this.ctx.queue.getQueueLength().catch(() => null);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // ── GET /v1/queue/length ─────────────────────────────────────────────────
    if (method === "GET" && url === "/v1/queue/length") {
      const length = this.ctx ? await this.ctx.queue.getQueueLength().catch(() => 0) : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ length }));
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found", path: url }));
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        this._running = false;
        resolve();
        return;
      }
      this.server.close((err) => {
        this._running = false;
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Create a Conductor HTTP server instance.
 *
 * @param _repoRoot Repo root (reserved for future config loading).
 * @param port      Port to listen on (default: 3000).
 */
export function createConductorServer(_repoRoot: string, port = 3000): Promise<ConductorServer> {
  return Promise.resolve(new ConductorHttpServer(port));
}
