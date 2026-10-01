// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./e2e-offline.cjs";

test("offline API can use local IPC (including ConPTY) without allowing TCP", async () => {
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\nexus-offline-test-${process.pid}`
      : join(tmpdir(), `nexus-offline-test-${process.pid}.sock`);
  const server = net.createServer((socket) => socket.end("local IPC"));
  await new Promise((resolve) => server.listen(pipe, resolve));
  try {
    const text = await new Promise((resolve, reject) => {
      const socket = net.connect(pipe);
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.equal(text, "local IPC");
    assert.throws(() => net.connect({ host: "example.com", port: 443 }), /disabled/);
    assert.throws(() => net.connect({ host: "127.0.0.1", port: 5432 }), /disabled/);
    await assert.rejects(fetch("https://example.com"), /disabled/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
