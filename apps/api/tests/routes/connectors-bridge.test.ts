// SPDX-License-Identifier: Apache-2.0
/**
 * Connectors sync real documents into a knowledge base. The web connector is
 * driven against a local HTTP server, which only the desktop mode may reach.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;
let site: http.Server;
let base = "";
const pages: Record<string, string> = {
  "/a": "<html><body><p>Alpha page about the quarterly roadmap.</p></body></html>",
  "/b": "<html><body><p>Beta page about the on-call rotation.</p></body></html>",
};

beforeAll(async () => {
  process.env.NEXUS_SECRETS_KEY ??= "ab".repeat(32);
  // Synced chunks go to the memory store; keep it in process for this file.
  delete process.env.DATABASE_URL;
  site = http.createServer((req, res) => {
    const body = pages[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "missing");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  delete process.env.NEXUS_DESKTOP;
  await app.close();
  site.close();
});

interface Job {
  id: string;
  status: string;
  documentsProcessed: number;
  documentsDeleted: number;
  errorMessage: string | null;
}

async function waitForJob(connectorId: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/sync/jobs`,
    });
    const [job] = res.json<{ jobs: Job[] }>().jobs;
    if (job && (job.status === "completed" || job.status === "failed")) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("sync did not finish");
}

describe("connectors", () => {
  it("rejects unknown sources, missing fields and private URLs on a shared server", async () => {
    const post = (body: object) =>
      app.inject({ method: "POST", url: "/api/connectors", payload: body });
    expect((await post({ source: "nope" })).statusCode).toBe(400);
    expect((await post({ source: "notion", credentials: { api_key: "x" } })).statusCode).toBe(400);
    delete process.env.NEXUS_DESKTOP;
    expect((await post({ source: "web", credentials: { base_url: `${base}/a` } })).statusCode).toBe(
      400,
    );
  });

  it("syncs pages into a knowledge base, then prunes the ones that disappear", async () => {
    process.env.NEXUS_DESKTOP = "1";
    const created = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: {
        name: "Docs",
        source: "web",
        credentials: { base_url: `${base}/a, ${base}/b` },
        syncConfig: { mode: "load", schedule: "daily" },
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    expect(created.body).not.toContain("base_url");

    const first = await waitForJob(id);
    expect(first).toMatchObject({ status: "completed", documentsProcessed: 2 });

    const list = await app.inject({ method: "GET", url: "/api/connectors" });
    const conn = list
      .json<{ connectors: { id: string; totalDocCount: number; kbId: string }[] }>()
      .connectors.find((c) => c.id === id)!;
    expect(conn.totalDocCount).toBe(2);
    expect(list.body).not.toContain("credentials");

    const hits = await app.inject({
      method: "GET",
      url: `/api/kb/${conn.kbId}/search?q=on-call rotation`,
    });
    expect(hits.json<{ results: { text: string }[] }>().results[0]?.text).toContain("on-call");

    const schedules = await app.inject({
      method: "GET",
      url: `/api/connectors/${id}/sync/schedules`,
    });
    expect(
      schedules.json<{ schedules: { cronExpression: string }[] }>().schedules[0]?.cronExpression,
    ).toBe("0 3 * * *");

    delete pages["/b"];
    const slim = await app.inject({
      method: "POST",
      url: `/api/connectors/${id}/sync`,
      payload: { mode: "slim" },
    });
    expect(slim.statusCode).toBe(201);
    expect(await waitForJob(id)).toMatchObject({ status: "completed", documentsDeleted: 1 });
  });

  it("validates and updates schedules", async () => {
    process.env.NEXUS_DESKTOP = "1";
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: { source: "web", credentials: { base_url: `${base}/a` } },
      })
    ).json<{ id: string }>();
    const url = `/api/connectors/${id}/sync/schedules`;
    expect(
      (await app.inject({ method: "POST", url, payload: { cronExpression: "bad" } })).statusCode,
    ).toBe(400);
    const s = (
      await app.inject({ method: "POST", url, payload: { cronExpression: "*/30 * * * *" } })
    ).json<{
      id: string;
      nextRunAt: string;
    }>();
    expect(s.nextRunAt).toBeTruthy();
    const put = await app.inject({
      method: "PUT",
      url: `${url}/${s.id}`,
      payload: { enabled: false },
    });
    expect(put.json<{ enabled: boolean }>().enabled).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `/api/connectors/${id}` })).statusCode).toBe(
      204,
    );
  });
});
