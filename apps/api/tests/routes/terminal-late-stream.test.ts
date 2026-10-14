// SPDX-License-Identifier: Apache-2.0
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

process.env.NEXUS_EXEC_MODE = "trusted";
process.env.NEXUS_EXEC_ALLOW = "node";
process.env.NEXUS_DESKTOP = "1";

// Real PTY manager's onExit synchronously replays an already-exited session.
const spawned = vi.hoisted(() => ({ id: "" }));
vi.mock("@nexus/pty", () => ({
  PtyManager: class {
    spawn(opts: { id: string }) {
      spawned.id = opts.id;
      return { id: opts.id };
    }
    list() {
      return [{ id: spawned.id, exited: true, exitCode: 0, tail: "v24.0.0" }];
    }
    onData(_id: string, callback: (data: string) => void) {
      callback("v24.0.0");
      return () => {};
    }
    onExit(_id: string, callback: (info: object) => void) {
      callback({ exitCode: 0 });
      return () => {};
    }
  },
}));
const { localPtyRoutes } = await import("../../src/routes/local-pty.ts");

it("closes SSE cleanly when subscribing after the terminal has already exited", async () => {
  const app = Fastify();
  await localPtyRoutes(app);
  try {
    const started = await app.inject({
      method: "POST",
      url: "/local/pty",
      remoteAddress: "127.0.0.1",
      payload: { command: "node", args: ["--version"] },
    });
    expect(started.statusCode, started.body).toBe(201);
    const response = await app.inject({
      url: `/local/pty/${spawned.id}/stream`,
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("v24.0.0");
    expect(response.body.match(/"type":"exit"/g)).toHaveLength(1);
  } finally {
    await app.close();
  }
});
