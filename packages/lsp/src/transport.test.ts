// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { minimalChildEnv } from "./client.ts";
import { LspTransport, LspTransportError, type LspTransportOptions } from "./transport.ts";

const FAKE_SERVER = fileURLToPath(new URL("./testing/fake-server.mjs", import.meta.url));

function makeTransport(
  args: string[] = [],
  extra: Partial<LspTransportOptions> = {},
): LspTransport {
  return new LspTransport({
    command: process.execPath,
    args: [FAKE_SERVER, ...args],
    env: minimalChildEnv(),
    cwd: tmpdir(),
    requestTimeoutMs: 2_000,
    ...extra,
  });
}

function argvTransport(extraArgs: string[]): Promise<string[]> {
  return new Promise<string[]>((resolveArgv) => {
    const transport = makeTransport(["--argv", ...extraArgs], {
      onNotification: (method, params) => {
        if (method !== "$fake/argv") return;
        resolveArgv((params as { argv: string[] }).argv);
      },
    });
    transport.start();
  });
}

describe("LspTransport", () => {
  it("routes out-of-order responses by id", async () => {
    const transport = makeTransport([
      "--delays",
      JSON.stringify({ "textDocument/definition": 120, "textDocument/hover": 5 }),
    ]);
    transport.start();
    const order: string[] = [];
    const definition = transport
      .request("textDocument/definition", { textDocument: { uri: "file:///a.ts" } })
      .then((value) => {
        order.push("definition");
        return value;
      });
    const hover = transport
      .request("textDocument/hover", { textDocument: { uri: "file:///a.ts" } })
      .then((value) => {
        order.push("hover");
        return value;
      });

    const [definitionResult, hoverResult] = await Promise.all([definition, hover]);
    expect(order).toEqual(["hover", "definition"]);
    expect(hoverResult).toEqual({ contents: { kind: "markdown", value: "fake hover" } });
    expect(definitionResult).toEqual([
      {
        uri: "file:///a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ]);
    transport.close();
  });

  it("rejects a timed-out request once and clears the pending entry", async () => {
    const transport = makeTransport(["--delays", JSON.stringify({ "textDocument/hover": 500 })], {
      requestTimeoutMs: 60,
    });
    transport.start();
    await expect(
      transport.request("textDocument/hover", { textDocument: { uri: "file:///a.ts" } }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(transport.pendingCount).toBe(0);
    transport.killTree();
  });

  it("rejects the in-flight request when the child dies", async () => {
    const transport = makeTransport(["--crash-on", "textDocument/hover"]);
    transport.start();
    await expect(
      transport.request("textDocument/hover", { textDocument: { uri: "file:///a.ts" } }),
    ).rejects.toBeInstanceOf(LspTransportError);
    expect(transport.pendingCount).toBe(0);
    expect(await transport.waitForExit(2_000)).toBe(true);
  });

  it("keeps a quoted path with spaces as one argv entry", async () => {
    const spaced = "C:\\Program Files\\nexus fixtures\\server.mjs";
    const received = await argvTransport([spaced]);
    expect(received).toContain(spaced);
    expect(received.filter((entry) => entry === spaced)).toHaveLength(1);
  });

  it("passes a path containing ; and && as one argv entry", async () => {
    const hostile = "C:\\tmp\\a;b && echo pwned\\server.mjs";
    const received = await argvTransport([hostile]);
    expect(received).toContain(hostile);
    expect(received).toHaveLength(1);
  });

  it("captures stderr in a 64 KB ring buffer", async () => {
    const transport = makeTransport(["--stderr-bytes", "70000"]);
    transport.start();
    await transport.request("initialize", {});
    expect(transport.stderrTail()).toHaveLength(64 * 1024);
    expect(/^e+$/.test(transport.stderrTail())).toBe(true);
    transport.close();
  });
});
