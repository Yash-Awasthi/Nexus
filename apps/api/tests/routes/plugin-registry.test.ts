// SPDX-License-Identifier: Apache-2.0
/**
 * §16.2 — server-side plugin registry route contract. Mirrors the wire
 * contract PluginRegistryClient speaks: list/get/publish/delete/install, with
 * fail-closed manifest validation (400 invalid_manifest) and 409 on duplicate
 * id+version.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

vi.mock("@nexus/db", () => ({ db: { execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } }));
vi.mock("pg", () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    on = vi.fn().mockReturnThis();
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: FakePool };
});

const AUTH_HEADERS = { authorization: "Bearer test" };

const MANIFEST = {
  id: "com.acme.summarizer",
  name: "Acme Summarizer",
  version: "1.2.3",
  entry: "./dist/plugin.js",
  capabilities: ["llm.inference", "storage.read"],
};

function publish(app: FastifyInstance, manifest: unknown, version?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/registry/plugins",
    headers: AUTH_HEADERS,
    payload: { manifest: version ? { ...(manifest as object), version } : manifest },
  });
}

describe("Plugin registry routes /api/v1/registry/plugins", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("publishes a valid manifest and lists it", async () => {
    const pub = await publish(app, MANIFEST);
    expect(pub.statusCode).toBe(201);
    expect(pub.json<{ manifest: { id: string } }>().manifest.id).toBe("com.acme.summarizer");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/registry/plugins",
      headers: AUTH_HEADERS,
    });
    expect(list.statusCode).toBe(200);
    const plugins = list.json<{ plugins: { manifest: { id: string } }[] }>().plugins;
    expect(plugins.some((p) => p.manifest.id === "com.acme.summarizer")).toBe(true);
  });

  it("rejects a malformed manifest with 400 + issue list (fail closed)", async () => {
    const res = await publish(app, { ...MANIFEST, id: "Bad Id!", version: "nope" });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; issues: string[] }>();
    expect(body.error).toBe("invalid_manifest");
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("409 on duplicate id+version", async () => {
    await publish(app, MANIFEST);
    const again = await publish(app, MANIFEST);
    expect(again.statusCode).toBe(409);
  });

  it("a new version of the same id publishes cleanly and get() returns the latest", async () => {
    await publish(app, MANIFEST, "1.2.3");
    await publish(app, MANIFEST, "1.3.0");
    const got = await app.inject({
      method: "GET",
      url: "/api/v1/registry/plugins/com.acme.summarizer",
      headers: AUTH_HEADERS,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ manifest: { version: string } }>().manifest.version).toBe("1.3.0");
  });

  it("get() 404s for an unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/registry/plugins/com.acme.missing",
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(404);
  });

  it("install bumps the download counter", async () => {
    await publish(app, MANIFEST);
    const inst = await app.inject({
      method: "POST",
      url: "/api/v1/registry/plugins/com.acme.summarizer/install",
      headers: AUTH_HEADERS,
    });
    expect(inst.statusCode).toBe(200);
    expect(inst.json<{ downloads: number }>().downloads).toBe(1);
  });

  it("delete removes every version of the plugin", async () => {
    await publish(app, MANIFEST, "1.2.3");
    await publish(app, MANIFEST, "1.3.0");
    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/registry/plugins/com.acme.summarizer",
      headers: AUTH_HEADERS,
    });
    expect([204, 200]).toContain(del.statusCode);
    const got = await app.inject({
      method: "GET",
      url: "/api/v1/registry/plugins/com.acme.summarizer",
      headers: AUTH_HEADERS,
    });
    expect(got.statusCode).toBe(404);
  });
});
