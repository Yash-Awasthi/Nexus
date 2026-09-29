// SPDX-License-Identifier: Apache-2.0
/** Host-installed plugins run through the sandbox runner; the runner is faked here. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DenoInvocation, SandboxExecutionResult } from "@nexus/plugin-sdk";
import { SandboxUnavailableError } from "@nexus/plugin-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "plugin-run-secret";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugins-"));
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_PLUGINS_DIR = DIR;

function install(id: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  const dir = path.join(DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", capabilities: [], ...manifest }),
  );
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
}

install("echo", { entry: "main.ts" }, { "main.ts": "// echo" });
install("needs-net", { entry: "main.ts", capabilities: ["search.web"] }, { "main.ts": "" });
install("escapes", { entry: "../echo/main.ts" }, {});
fs.mkdirSync(path.join(DIR, "broken"));
fs.writeFileSync(path.join(DIR, "broken", "manifest.json"), "{not json");

const calls: DenoInvocation[] = [];
let next: (inv: DenoInvocation) => Promise<SandboxExecutionResult> = async (inv) => ({
  ok: true,
  stdout: inv.payload,
  stderr: "",
  exitCode: 0,
  parsed: { echoed: JSON.parse(inv.payload) },
});

function auth(): { authorization: string } {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: crypto.randomUUID(), role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

let app: FastifyInstance;
beforeAll(async () => {
  const { pluginRunRoutes } = await import("../../src/routes/plugin-run.js");
  app = Fastify();
  await app.register(pluginRunRoutes, {
    runnerFn: (inv: DenoInvocation) => {
      calls.push(inv);
      return next(inv);
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

const run = (id: string, input: unknown, headers = auth()) =>
  app.inject({ method: "POST", url: `/plugins/${id}/run`, headers, payload: { input } });

describe("plugin run", () => {
  it("lists the valid installed plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/plugins/local", headers: auth() });
    const ids = res
      .json<{ plugins: { id: string }[] }>()
      .plugins.map((p) => p.id)
      .sort();
    expect(ids).toEqual(["echo", "escapes", "needs-net"]);
  });

  it("runs a plugin's entry with the input and returns what it printed", async () => {
    const res = await run("echo", { n: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ output: { echoed: { n: 1 } } });
    const inv = calls.at(-1)!;
    expect(inv.scriptPath).toBe(fs.realpathSync(path.join(DIR, "echo", "main.ts")));
    expect(inv.grantedCapabilities).toEqual([]);
  });

  it("refuses without a token, unknown plugins, capability requests and escaping entries", async () => {
    expect((await run("echo", {}, {} as never)).statusCode).toBe(401);
    expect((await run("nope", {})).statusCode).toBe(404);
    const net = await run("needs-net", {});
    expect(net.statusCode).toBe(409);
    expect(net.json<{ message: string }>().message).toMatch(/search\.web/);
    expect((await run("escapes", {})).statusCode).toBe(400);
    expect((await run("echo", "x".repeat(20_000))).statusCode).toBe(413);
  });

  it("reports a failed run and a missing sandbox", async () => {
    next = async () => ({ ok: false, stdout: "", stderr: "boom", exitCode: 2 });
    const failed = await run("echo", {});
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({ exitCode: 2, stderr: "boom" });

    next = async () => {
      throw new SandboxUnavailableError("deno missing");
    };
    expect((await run("echo", {})).statusCode).toBe(503);
  });
});
