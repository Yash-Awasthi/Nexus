// SPDX-License-Identifier: Apache-2.0
/**
 * Stage B1 — the spec is generated from the live route table, and every path
 * declares how much it can be trusted.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildServer } from "../../src/server.js";

const MATURITIES = ["durable", "dedicated-volatile", "bridge"];

interface Operation {
  tags?: string[];
}
interface Spec {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, Operation>>;
  tags?: { name: string }[];
}

let app: FastifyInstance;
let spec: Spec;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  expect(res.statusCode).toBe(200);
  spec = res.json<Spec>();
});

afterAll(async () => {
  await app.close();
});

/** Every (method, path) pair in the document. */
function operations(): { method: string; path: string; op: Operation }[] {
  const out: { method: string; path: string; op: Operation }[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) out.push({ method, path, op });
  }
  return out;
}

describe("GET /openapi.json", () => {
  it("is an OpenAPI 3.1 document", () => {
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.info.title).toBe("Nexus API");
  });

  // The hand-written openapi.yaml described 21 paths. A path with GET and POST is
  // one path and two operations; both are asserted so neither is read as the other.
  it("covers the real surface, not the 21 paths the hand-written file had", () => {
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(500);
    expect(operations().length).toBeGreaterThanOrEqual(600);
  });

  it("tags every operation with exactly one maturity", () => {
    const bad = operations().filter(
      ({ op }) => (op.tags ?? []).filter((t) => MATURITIES.includes(t)).length !== 1,
    );
    expect(bad.map((b) => `${b.method} ${b.path}`)).toEqual([]);
  });

  it("declares each maturity tag at the document level", () => {
    const declared = new Set((spec.tags ?? []).map((t) => t.name));
    for (const m of MATURITIES) expect(declared.has(m)).toBe(true);
  });

  it("classifies the bridge and the dedicated handlers apart", () => {
    const tagOf = (path: string, method = "get") =>
      spec.paths[path]?.[method]?.tags?.find((t) => MATURITIES.includes(t));

    expect(tagOf("/api/v1/council/verdicts")).toBe("durable");
    expect(tagOf("/api/archetypes")).toBe("durable");
    expect(tagOf("/api/providers")).toBe("bridge");
    // Extracted out of the bridge, but its store is still a process Map.
    expect(tagOf("/api/sandbox/execute", "post")).toBe("dedicated-volatile");
  });

  it("needs no credential of its own", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
  });
});
