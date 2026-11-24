// SPDX-License-Identifier: Apache-2.0
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { Runner, RunnerResult } from "@nexus/sandbox";
import { SANDBOX_LANGUAGES } from "@nexus/sandbox";

import { Pairing } from "../src/pairing.ts";
import { createHelperServer } from "../src/server.ts";

const ORIGIN = "http://localhost:5173";
const IMAGE = "nexus-sandbox:local";

function ok(stdout = "42\n"): RunnerResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

const fakeRunner: Runner = async () => ok();

async function start(options: {
  runner?: Runner;
  pairing?: Pairing;
  allowedOrigins?: string[];
  image?: string;
  allowedImages?: string[];
  dockerReady?: () => Promise<boolean>;
}) {
  const pairing = options.pairing ?? new Pairing();
  const server = createHelperServer({
    image: options.image ?? IMAGE,
    allowedImages: options.allowedImages ?? [IMAGE],
    allowedOrigins: options.allowedOrigins ?? [ORIGIN],
    runner: options.runner ?? fakeRunner,
    pairing,
    dockerReady: options.dockerReady ?? (async () => true),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return { server, url, pairing, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let running: { close: () => Promise<void> } | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

describe("sandbox helper", () => {
  it("answers /health with the image and its languages", async () => {
    const helper = await start({});
    running = helper;

    const res = await fetch(`${helper.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["image"]).toBe(IMAGE);
    expect(body["docker"]).toBe(true);
    expect(body["languages"]).toContain("python");
    expect(body["languages"]).toEqual([...SANDBOX_LANGUAGES]);
  });

  it("answers the private-network preflight for an allowed origin", async () => {
    const helper = await start({});
    running = helper;

    const res = await fetch(`${helper.url}/run`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("refuses an origin that is not on the allowlist", async () => {
    const helper = await start({});
    running = helper;

    const res = await fetch(`${helper.url}/health`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a run before pairing", async () => {
    const helper = await start({});
    running = helper;

    const res = await fetch(`${helper.url}/run`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ language: "javascript", code: "1 + 1" }),
    });
    expect(res.status).toBe(401);
  });

  it("pairs with the code, then runs and returns the result", async () => {
    let seen: { language?: string; timeoutMs?: number } = {};
    const runner: Runner = async (_cmd, _args, opts) => {
      seen = { timeoutMs: opts.timeoutMs };
      return ok();
    };
    const helper = await start({ runner });
    running = helper;

    const bad = await fetch(`${helper.url}/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "999999" }),
    });
    expect(bad.status).toBe(401);

    const code = helper.pairing.current().code;
    const paired = await fetch(`${helper.url}/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(paired.status).toBe(200);
    const { token } = (await paired.json()) as { token: string };

    const run = await fetch(`${helper.url}/run`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ language: "javascript", code: "6 * 7" }),
    });
    expect(run.status).toBe(200);
    const result = (await run.json()) as { stdout: string; exitCode: number };
    expect(result.stdout).toBe("42\n");
    expect(result.exitCode).toBe(0);
    expect(seen.timeoutMs).toBe(30_000);
  });

  it("caps a requested timeout at 30 seconds", async () => {
    let timeoutMs = 0;
    const runner: Runner = async (_cmd, _args, opts) => {
      timeoutMs = opts.timeoutMs;
      return ok();
    };
    const helper = await start({ runner });
    running = helper;
    const { code } = helper.pairing.start();
    const { token } = helper.pairing.redeem(code, ORIGIN)!;

    const res = await fetch(`${helper.url}/run`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ language: "python", code: "print(1)", timeoutMs: 999_999 }),
    });
    expect(res.status).toBe(200);
    expect(timeoutMs).toBe(30_000);
  });

  it("runs the image languages it advertises: go, rust and ruby", async () => {
    const helper = await start({});
    running = helper;
    const { code } = helper.pairing.start();
    const { token } = helper.pairing.redeem(code, ORIGIN)!;

    for (const language of ["go", "rust", "ruby"]) {
      const res = await fetch(`${helper.url}/run`, {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language, code: "print 1" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { exitCode: number }).exitCode).toBe(0);
    }
  });

  it("refuses a language it does not run", async () => {
    const helper = await start({});
    running = helper;
    const { code } = helper.pairing.start();
    const { token } = helper.pairing.redeem(code, ORIGIN)!;

    const res = await fetch(`${helper.url}/run`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ language: "brainfuck", code: "++" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an image that is not on the allowlist", () => {
    expect(() =>
      createHelperServer({
        image: "someone-elses:latest",
        allowedImages: [IMAGE],
        allowedOrigins: [ORIGIN],
        runner: fakeRunner,
      }),
    ).toThrow(/allowlist/);
  });

  it("refuses a second run while one is in flight", async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runner: Runner = async () => {
      entered();
      await gate;
      return ok();
    };
    const helper = await start({ runner });
    running = helper;
    const { code } = helper.pairing.start();
    const { token } = helper.pairing.redeem(code, ORIGIN)!;
    const call = () =>
      fetch(`${helper.url}/run`, {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language: "bash", code: "sleep 1" }),
      });

    const first = call();
    await reached;
    const second = await call();
    expect(second.status).toBe(429);

    release();
    expect((await first).status).toBe(200);
  });

  it("refuses an oversized body", async () => {
    const helper = await start({});
    running = helper;
    const { code } = helper.pairing.start();
    const { token } = helper.pairing.redeem(code, ORIGIN)!;

    const res = await fetch(`${helper.url}/run`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ language: "bash", code: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
