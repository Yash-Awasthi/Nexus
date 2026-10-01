// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { test } from "node:test";
import "./unit-offline.cjs";

test("unit guard permits its own HTTP fixture, not external or existing services", async () => {
  const server = createServer((_req, res) => res.end("fixture"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "fixture");
    assert.throws(() => net.connect({ host: "example.com", port: 443 }), /disabled/);
    assert.throws(() => net.connect({ host: "127.0.0.1", port: 5432 }), /disabled/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
