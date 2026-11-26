// SPDX-License-Identifier: Apache-2.0
/**
 * The offline path: a laptop with Node and nothing else — no Docker, no Ollama, no
 * Redis, no database server — must still boot and answer `/health`.
 *
 * This is the claim `docs/DEPLOYMENT.md` §"Offline machine" makes, and it is the one
 * that decays quietly: an import of a Docker-orchestrating module or a required model
 * provider at boot turns "works offline" into "works on my machine". So the test
 * removes the network-shaped variables and boots the real server.
 *
 * What it does not claim: that chat works. Without a model there is nothing to answer
 * with, and `/health` says so instead of pretending.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/** Variables whose presence would let the server reach something. */
const OFFLINE_VARS = [
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "OLLAMA_URL",
  "OLLAMA_HOST",
  "DOCKER_HOST",
  "NEXUS_SANDBOX_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
];

const saved = new Map<string, string | undefined>();

beforeAll(() => {
  for (const name of OFFLINE_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  // The embedded database is the offline database; a server URL is not available here.
  saved.set("DATABASE_URL", process.env.DATABASE_URL);
  process.env.DATABASE_URL = "pglite://:memory:offline";
});

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("offline machine", () => {
  it("boots and answers /health with nothing reachable", async () => {
    vi.resetModules();
    const { buildServer } = await import("../../src/server.ts");
    const app = await buildServer();
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok" });

    await app.close();
  }, 60_000);

  it("reports readiness as a fact, not a crash", async () => {
    vi.resetModules();
    const { buildServer } = await import("../../src/server.ts");
    const app = await buildServer();
    await app.ready();

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    // 200 or 503 both mean "it answered"; a 500 or a hang is what this rules out.
    expect([200, 503]).toContain(ready.statusCode);
    const body = ready.json() as { status: string; checks: Record<string, string> };
    expect(["ready", "degraded", "down"]).toContain(body.status);
    // The KV leg is the one that has no external dependency offline: it must pass.
    expect(body.checks.kv, JSON.stringify(body)).toBe("ok");

    await app.close();
  }, 60_000);

  it("documents the offline machine where a user looks for it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const doc = readFileSync(
      fileURLToPath(new URL("../../../../docs/DEPLOYMENT.md", import.meta.url)),
      "utf8",
    );
    expect(doc).toMatch(/Offline machine/);
    for (const phrase of ["no Docker", "no Ollama", "/health"]) expect(doc).toContain(phrase);
  });
});
