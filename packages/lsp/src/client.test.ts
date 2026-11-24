// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { LspClient, createLspClient, type LspClientOptions } from "./client.ts";

const FAKE_SERVER = fileURLToPath(new URL("./testing/fake-server.mjs", import.meta.url));
const FAKE_COMMAND = { command: process.execPath, args: [FAKE_SERVER] };

function options(overrides: Partial<LspClientOptions> = {}): LspClientOptions {
  return { command: FAKE_COMMAND, cwd: tmpdir(), ...overrides };
}

describe("LspClient handshake", () => {
  it("sends initialize then initialized and stores capabilities", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    let resolveInitialized: () => void = () => {};
    const initialized = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    const client = await createLspClient(
      options({
        onNotification: (method, params) => {
          seen.push({ method, params });
          if (method === "$fake/initialized") resolveInitialized();
        },
      }),
    );
    await initialized;

    const received = seen.find((entry) => entry.method === "$fake/initialize")?.params as {
      processId: number;
      rootUri: string;
      workspaceFolders: unknown;
      capabilities: { textDocument: { synchronization: unknown } };
    };
    expect(received.processId).toBe(process.pid);
    expect(received.rootUri).toBe(pathToFileURL(tmpdir()).href);
    expect(received.workspaceFolders).toBeNull();
    expect(received.capabilities.textDocument.synchronization).toBeDefined();

    const methods = seen.map((entry) => entry.method);
    expect(methods).toContain("$fake/initialized");
    expect(methods.indexOf("$fake/initialize")).toBeLessThan(methods.indexOf("$fake/initialized"));

    expect(client.capabilities).toMatchObject({
      textDocumentSync: 1,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: true,
      codeActionProvider: true,
    });
    expect(client.serverInfo).toEqual({ name: "fake-lsp", version: "1.0.0" });

    await client.shutdown();
  });

  it("refuses to continue when initialize exceeds the start timeout", async () => {
    const client = new LspClient(
      options({
        command: {
          command: process.execPath,
          args: [FAKE_SERVER, "--delays", '{"initialize":500}'],
        },
        config: { startTimeoutMs: 80 },
      }),
    );
    await expect(client.start()).rejects.toThrow(/initialize failed/);
    expect(client.running).toBe(false);
  });

  it("gives the child a minimal environment with no API secrets", async () => {
    const previous = process.env.NEXUS_API_KEY;
    process.env.NEXUS_API_KEY = "secret-not-for-children";
    try {
      const client = await createLspClient(options());
      const env = await client.request<Record<string, string>>("nexus/env");
      expect(env.NEXUS_API_KEY).toBeUndefined();
      // Windows adds a few OS-required variables; no Nexus secret may survive.
      expect(Object.keys(env).filter((name) => name.toUpperCase().startsWith("NEXUS_"))).toEqual(
        [],
      );
      expect(Object.keys(env).some((name) => name.toUpperCase() === "PATH")).toBe(true);
      await client.shutdown();
    } finally {
      if (previous === undefined) delete process.env.NEXUS_API_KEY;
      else process.env.NEXUS_API_KEY = previous;
    }
  });
});

describe("LspClient shutdown", () => {
  it("kills the tree when the server ignores shutdown", async () => {
    const client = await createLspClient(
      options({ command: { command: process.execPath, args: [FAKE_SERVER, "--ignore-shutdown"] } }),
    );
    const started = Date.now();
    await client.shutdown();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    expect(client.transport.exited).toBe(true);
  }, 10_000);

  it("exits within the grace period for a cooperating server", async () => {
    const client = await createLspClient(options());
    await client.shutdown();
    expect(client.transport.exited).toBe(true);
    expect(client.transport.pendingCount).toBe(0);
  });
});

describe("LspClient stderr log level", () => {
  async function runWithLog(log: "off" | "info") {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const client = await createLspClient(
        options({
          command: { command: process.execPath, args: [FAKE_SERVER, "--stderr-bytes", "16"] },
          config: { log },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const captured = client.stderr;
      await client.shutdown();
      return { written: written.filter((line) => line.includes("[lsp]")), captured };
    } finally {
      process.stderr.write = original;
    }
  }

  it("keeps captured stderr off the console when NEXUS_LSP_LOG is off", async () => {
    const { written, captured } = await runWithLog("off");
    expect(written).toHaveLength(0);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("forwards captured stderr when NEXUS_LSP_LOG is info", async () => {
    const { written } = await runWithLog("info");
    expect(written.length).toBeGreaterThan(0);
  });
});
