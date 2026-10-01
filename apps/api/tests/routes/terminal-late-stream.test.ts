// SPDX-License-Identifier: Apache-2.0
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

// Real PTY manager's onExit synchronously replays an already-exited session.
vi.mock("@nexus/pty", () => ({
  PtyManager: class {
    list() {
      return [{ id: "finished", exited: true, exitCode: 0, tail: "v24.0.0" }];
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
const { localPtyRoutes } = await import("../../src/routes/local-pty.js");

it("closes SSE cleanly when subscribing after the terminal has already exited", async () => {
  const app = Fastify();
  await localPtyRoutes(app);
  try {
    const response = await app.inject({
      url: "/local/pty/finished/stream",
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("v24.0.0");
    expect(response.body.match(/"type":"exit"/g)).toHaveLength(1);
  } finally {
    await app.close();
  }
});
