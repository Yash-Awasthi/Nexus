// SPDX-License-Identifier: Apache-2.0
/** The CLI end to end against a stand-in API: the paths it calls, what it prints, how it exits. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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

  it("prints the sources recorded for a research run", async () => {
    seen.length = 0;
    answer = () => [200, { query: "tides", total: 2, markdownRef: "citations/run-1.md" }];
    const run = await nexus("research", "citations", "run-1");
    expect(seen).toEqual(["GET /api/v1/researcher/run-1/citations"]);
    expect(run.out).toContain("2 source(s) for: tides");
    expect(run.out).toContain("citations/run-1.md");
    expect(run.code).toBe(0);
  }, 60_000);

  it("submits a research query and prints the synthesis with its sources", async () => {
    seen.length = 0;
    answer = () => [
      201,
      {
        runId: "run-2",
        query: "why tides",
        synthesis: "Tides follow the moon.",
        durationMs: 1200,
        citations: [],
        richCitations: [{ citationKey: "1", title: "Tides", url: "https://example.test/tides" }],
      },
    ];
    const run = await nexus("research", "submit", "why tides", "--max", "3");
    // One round trip: m1.4.2 replaced the dead submit-plus-stream pair with the
    // route that answers with the report, and the CLI prints it from that answer.
    expect(seen).toEqual(["POST /api/v1/researcher/research"]);
    expect(bodies.at(-1)).toEqual({ query: "why tides", maxResults: 3 });
    expect(run.out).toContain("Tides follow the moon.");
    expect(run.out).toContain("https://example.test/tides");
    expect(run.out).toContain("nexus research citations run-2");
    expect(run.code).toBe(0);
  }, 60_000);

  it("runs a workflow and prints one line per step, then the result", async () => {
    seen.length = 0;
    answer = () => [
      200,
      {
        status: "success",
        result: { answer: "three decisions" },
        events: [{ type: "step:finished", stepId: "decide", timestamp: "t" }],
      },
    ];
    const run = await nexus("run", "wf_1", "--json");
    // Workflows are on the unversioned bridge: `/api/workflows`, not `/api/v1/workflows`.
    // The parity check (`scripts/cli-parity.mjs`) is what found this — a 404 nobody hit yet.
    expect(seen).toEqual(["POST /api/workflows/wf_1/run"]);
    expect(run.out).toContain('"status": "success"');
    expect(run.code).toBe(0);
  }, 60_000);

  it("writes the workflow result to a file and exits 1 when the run failed", async () => {
    const out = path.join(os.tmpdir(), `nexus-run-${randomUUID()}.json`);
    answer = () => [200, { status: "error", message: "model refused" }];
    const run = await nexus("run", "wf_2", "--json", "--out", out);
    expect(run.code).toBe(1);
    const written = JSON.parse(fs.readFileSync(out, "utf8")) as { status: string };
    expect(written.status).toBe("error");
    fs.unlinkSync(out);
  }, 60_000);

  it("prints a council verdict as JSON and exits 1 on a rejection", async () => {
    answer = () => [
      200,
      {
        ok: true,
        verdictId: "v-1",
        result: { outcome: "rejected", consensus: 0.2, summary: "no" },
      },
    ];
    const run = await nexus("council", "deliberate", "--title", "Ship?", "--json");
    expect(run.out).toContain('"outcome": "rejected"');
    expect(run.code).toBe(1);
  }, 60_000);
});
