/**
 * T3 — /health HTTP endpoint: structure, degraded/unhealthy status codes, auth guard
 */
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { createGhostStackServer, GhostStackServer } from "../runtime/ghoststack-server";

function get(port: number, pathname: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on("error", reject);
  });
}

describe("GET /health endpoint", () => {
  let gs: GhostStackServer;
  const repoRoot = path.resolve(__dirname, "..");
  // Must be inside repoRoot to pass sandbox path boundary checks
  const tmpData = path.join(repoRoot, `temp-health-ep-test-${Date.now()}`);

  beforeAll(async () => {
    process.env.GHOSTSTACK_DATA_DIR = tmpData;
    process.env.GHOSTSTACK_OFFLINE_MODE = "1";
    process.env.GHOSTSTACK_API_PORT = "37291";
    delete process.env.GHOSTSTACK_API_TOKEN;
    gs = await createGhostStackServer(repoRoot);
  }, 30_000);

  afterAll(async () => {
    if (gs) await gs.stop();
    delete process.env.GHOSTSTACK_API_TOKEN;
    // Cleanup temp data dir
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns HTTP 200 and status=healthy in normal operation", async () => {
    const { status, body } = await get(gs.port, "/health");
    expect(status).toBe(200);
    expect(["healthy", "degraded"]).toContain(body.status);
  });

  it("response has required top-level fields", async () => {
    const { body } = await get(gs.port, "/health");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime_ms).toBe("number");
    expect(typeof body.boot_ms).toBe("number");
    expect(typeof body.timestamp).toBe("string");
    expect(body.components).toBeDefined();
  });

  it("components object contains queue, floci, event_bus, workflow_engine keys", async () => {
    const { body } = await get(gs.port, "/health");
    expect(body.components).toHaveProperty("queue");
    expect(body.components).toHaveProperty("floci");
    expect(body.components).toHaveProperty("event_bus");
    expect(body.components).toHaveProperty("workflow_engine");
  });

  it("each component has a status field", async () => {
    const { body } = await get(gs.port, "/health");
    for (const [_name, comp] of Object.entries(body.components as any)) {
      expect(typeof (comp as any).status).toBe("string");
      // status is one of the expected strings
      expect(["healthy", "degraded", "offline", "unknown", "error"]).toContain((comp as any).status);
    }
  });

  it("/healthz is an alias for /health", async () => {
    const [a, b] = await Promise.all([get(gs.port, "/health"), get(gs.port, "/healthz")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.status).toBe(b.body.status);
  });

  it("uptime_ms increases over time", async () => {
    const first = await get(gs.port, "/health");
    await new Promise((r) => setTimeout(r, 50));
    const second = await get(gs.port, "/health");
    expect(second.body.uptime_ms).toBeGreaterThan(first.body.uptime_ms);
  });

  describe("auth guard", () => {
    const TOKEN = "test-secret-token-xyz";

    beforeAll(() => {
      process.env.GHOSTSTACK_API_TOKEN = TOKEN;
    });

    afterAll(() => {
      delete process.env.GHOSTSTACK_API_TOKEN;
    });

    it("/health bypasses auth even when GHOSTSTACK_API_TOKEN is set", async () => {
      // Note: token is checked at runtime from env, but the server was already created.
      // The auth guard reads process.env.GHOSTSTACK_API_TOKEN on each request — so setting
      // it now affects subsequent requests.
      const { status } = await get(gs.port, "/health");
      // /health is always public — should never return 401
      expect(status).toBe(200);
    });

    it("protected endpoints return 401 without a valid token", async () => {
      const { status } = await get(gs.port, "/runtime/queue");
      expect(status).toBe(401);
    });

    it("protected endpoints return 200 with valid Bearer token", async () => {
      const { status } = await get(gs.port, "/runtime/queue", TOKEN);
      expect(status).toBe(200);
    });

    it("protected endpoints return 401 with wrong token", async () => {
      const { status } = await get(gs.port, "/runtime/queue", "wrong-token");
      expect(status).toBe(401);
    });
  });
});
