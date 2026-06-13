// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

vi.mock("@nexus/db", () => ({
  db: { execute: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@nexus/council", () => ({
  CouncilService: vi.fn().mockImplementation(() => ({
    deliberate: vi.fn().mockResolvedValue({ outcome: "approved" }),
  })),
}));

import { buildServer } from "../src/server.js";

describe("buildServer()", () => {
  it("creates a Fastify instance that can be readied", async () => {
    const app = await buildServer();
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it("registers the /health route under root (no /api/v1 prefix)", async () => {
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("mounts API routes under /api/v1", async () => {
    const app = await buildServer();
    await app.ready();

    // Any route under /api/v1 should exist (not 404)
    const res = await app.inject({ method: "GET", url: "/api/v1/council/verdicts/unknown-id" });
    // Should not be a 404 — either 200, 400, 401, or 500
    expect(res.statusCode).not.toBe(404);
    await app.close();
  });

  it("returns 404 for unknown paths", async () => {
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/totally-unknown-path" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
