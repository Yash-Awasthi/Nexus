// SPDX-License-Identifier: Apache-2.0
/** The CLI end to end against a stand-in API: the paths it calls, what it prints, how it exits. */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const seen: string[] = [];
const bodies: unknown[] = [];
let answer: (method: string, url: string) => [number, unknown] = () => [404, {}];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (raw) bodies.push(JSON.parse(raw));
      const [status, body] = answer(req.method ?? "GET", req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function nexus(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", entry, ...args], {
      env: { ...process.env, NEXUS_API_URL: base, NEXUS_API_KEY: "k", FORCE_COLOR: "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("nexus CLI", () => {
  it("exits 1, not a crash, when the API answers with an error", async () => {
    answer = () => [500, { error: "boom" }];
    const run = await nexus("memory", "list");
    expect(run.out).toContain("boom");
    expect(run.code).toBe(1);
  }, 60_000);

  it("prints the message of a structured API error", async () => {
    answer = () => [429, { type: "error", error: { type: "RATE_LIMITED", message: "slow down" } }];
    const run = await nexus("gateway", "chat", "hi");
    expect(run.out).toContain("HTTP 429: slow down");
  }, 60_000);

  it("lists the caller's recent model spend", async () => {
    answer = () => [
      200,
      {
        totalRuns: 1,
        totalUsd: 0.25,
        runs: [{ ts: "2026-09-28T10:00:00.000Z", model: "groq/llama", costUsd: 0.25 }],
      },
    ];
    const run = await nexus("gateway", "cost-report");
    expect(run.out).toContain("$0.2500");
    expect(run.out).toContain("groq/llama");
    expect(run.code).toBe(0);
  }, 60_000);

  it("lists memories from the memory endpoint", async () => {
    seen.length = 0;
    answer = () => [200, { results: [{ id: "m1234567890", text: "likes tea" }], total: 1 }];
    const run = await nexus("memory", "list", "--limit", "5");
    expect(seen).toEqual(["GET /api/v1/memory?limit=5"]);
    expect(run.out).toContain("likes tea");
    expect(run.code).toBe(0);
  }, 60_000);

  it("stores a memory as text with its category", async () => {
    seen.length = 0;
    answer = () => [201, { id: "m-new" }];
    const run = await nexus("memory", "store", "likes coffee", "--category", "prefs");
    expect(seen).toEqual(["POST /api/v1/memory"]);
    expect(bodies.at(-1)).toEqual({ text: "likes coffee", metadata: { category: "prefs" } });
    expect(run.out).toContain("m-new");
  }, 60_000);

  it("lists research jobs from the research endpoint", async () => {
    seen.length = 0;
    answer = () => [200, { jobs: [{ id: "job-1", status: "done", query: "tides" }] }];
    const run = await nexus("research", "list");
    expect(seen).toEqual(["GET /api/research"]);
    expect(run.out).toContain("tides");
  }, 60_000);

  it("runs a research job through its stream and prints the report", async () => {
    seen.length = 0;
    answer = (method, url) =>
      method === "POST"
        ? [201, { id: "job-2", status: "running" }]
        : url.endsWith("/stream")
          ? [200, "unused"]
          : [404, {}];
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url?.endsWith("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "phase_start", label: "Planning" })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ type: "report", content: "Tides follow the moon." })}\n\n`,
        );
        res.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        return;
      }
      const [status, body] = answer(req.method ?? "GET", req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    const run = await nexus("research", "submit", "why tides");
    expect(seen).toEqual(["POST /api/research", "GET /api/research/job-2/stream"]);
    expect(run.out).toContain("Tides follow the moon.");
    expect(run.code).toBe(0);
  }, 60_000);
});
