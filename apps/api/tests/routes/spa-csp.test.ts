// SPDX-License-Identifier: Apache-2.0
/**
 * When the API serves the built UI, the page's inline boot scripts must be
 * allowed by the script policy, or the app never starts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

const boot = "window.__boot = 1;";
let app: FastifyInstance;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "spa-"));
  writeFileSync(
    join(dir, "index.html"),
    `<html><head><script>${boot}</script><script type="module" src="/a.js"></script></head></html>`,
  );
  process.env.NEXUS_SPA_DIR = dir;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  delete process.env.NEXUS_SPA_DIR;
  await app.close();
});

describe("SPA content security policy", () => {
  it("allows the inline boot script by hash and nothing broader", async () => {
    const res = await app.inject({ method: "GET", url: "/some/client/route" });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    const hash = createHash("sha256").update(boot).digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp.match(/'sha256-/g)).toHaveLength(1);
  });

  it("serves client routes that merely start with /api, and 404s real API paths", async () => {
    expect((await app.inject({ method: "GET", url: "/api-tokens" })).statusCode).toBe(200);
    const miss = await app.inject({ method: "GET", url: "/api/no-such-route" });
    expect(miss.statusCode).toBe(404);
    expect(miss.headers["content-type"]).toContain("json");
  });
});
