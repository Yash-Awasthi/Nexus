// SPDX-License-Identifier: Apache-2.0
/**
 * Serving the built SPA from the API (spec milestone M2) — the thing that puts
 * the desktop renderer and the API on one origin.
 *
 * Built against a temporary directory rather than apps/ui's real build, so the
 * test says nothing about whether the UI happens to be built.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;
let dir: string;
let savedSpaDir: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-spa-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Nexus</title>", "utf8");
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n", "utf8");
  writeFileSync(join(dir, "widget.js"), "customElements.define('x-w', class {});\n", "utf8");

  savedSpaDir = process.env.NEXUS_SPA_DIR;
  process.env.NEXUS_SPA_DIR = dir;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (savedSpaDir === undefined) delete process.env.NEXUS_SPA_DIR;
  else process.env.NEXUS_SPA_DIR = savedSpaDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("SPA serving", () => {
  it("serves the shell at the root", async () => {
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Nexus</title>");
  });

  it("serves a built asset", async () => {
    const res = await app.inject({ method: "GET", url: "/app.js" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const x = 1;");
  });

  it("lets other sites load the widget script but not the app's own files", async () => {
    const widget = await app.inject({ method: "GET", url: "/widget.js?v=1" });
    expect(widget.statusCode).toBe(200);
    expect(widget.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    const asset = await app.inject({ method: "GET", url: "/app.js" });
    expect(asset.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("hands a client-side route the shell instead of a 404", async () => {
    const res = await app.inject({ method: "GET", url: "/deliberations/abc" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Nexus</title>");
  });

  it("still answers an unknown API path with a JSON 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("Not Found");
  });

  it("does not answer a non-GET with the shell", async () => {
    const res = await app.inject({ method: "POST", url: "/deliberations/abc" });

    expect(res.statusCode).toBe(404);
  });
});
