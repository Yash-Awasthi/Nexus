// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-015: probing a saved provider's model list goes through the pinned SSRF fetch. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, it } from "vitest";

import { fetchModelCatalog } from "../../src/routes/api-bridge.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  delete process.env.NEXUS_DESKTOP;
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "internal-only-model" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

it("does not read an internal service's model list", async () => {
  expect(await fetchModelCatalog(base, null)).toBeNull();
});
