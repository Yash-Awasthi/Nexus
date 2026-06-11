import * as http from "http";
import * as path from "path";
import { createRuntimeContext, startRuntime, stopRuntime } from "../runtime/runtime-context";
import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api";

describe("GhostStack HTTP diagnostic server", () => {
  let server: http.Server;
  let port = 0;
  let runtimeCtx: Awaited<ReturnType<typeof createRuntimeContext>> | null = null;

  beforeAll(async () => {
    const repoRoot = path.resolve(__dirname, "..");
    process.env.GHOSTSTACK_DATA_DIR = path.join(__dirname, "../temp-http-server-db");
    const ctx = await createRuntimeContext(repoRoot);
    runtimeCtx = ctx;
    await startRuntime(ctx);
    const api = new RuntimeDiagnosticAPI(ctx.inspector);

    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const data = await api.handle(req.method || "GET", url.pathname);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      } catch (err: any) {
        res.statusCode = err.message?.startsWith("Not Found") ? 404 : 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (runtimeCtx) {
      await stopRuntime(runtimeCtx);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves GET /health", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    // In offline mode (no Floci), health may report "degraded"; accept both
    expect(["healthy", "degraded"]).toContain(body.status);
  });

  it("lists loaded workflow definitions from specs/", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runtime/workflows`);
    expect(res.status).toBe(200);
    const workflows = (await res.json()) as Array<{ id: string }>;
    const demo = workflows.find((w) => w.id === "demo-etl");
    expect(demo).toBeDefined();
  });
});
