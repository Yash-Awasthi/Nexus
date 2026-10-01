// SPDX-License-Identifier: Apache-2.0
/**
 * Behind a reverse proxy every request arrives from the proxy's address, so per-IP limits would
 * be shared by every user. NEXUS_TRUST_PROXY names the proxies whose X-Forwarded-For is believed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.NEXUS_TRUST_PROXY = "loopback";
const { buildServer } = await import("../../src/server.js");
const { parseTrustProxy } = await import("../../src/lib/trust-proxy.js");

it("reads hop counts, true/false and address lists", () => {
  expect(parseTrustProxy(undefined)).toBe(false);
  expect(parseTrustProxy("")).toBe(false);
  expect(parseTrustProxy("true")).toBe(true);
  expect(parseTrustProxy("false")).toBe(false);
  expect(parseTrustProxy("1")).toBe(1);
  expect(parseTrustProxy("loopback, uniquelocal")).toEqual(["loopback", "uniquelocal"]);
});

const app = await buildServer();
const seen: string[] = [];
beforeAll(async () => {
  app.addHook("onRequest", async (req) => {
    seen.push(req.ip);
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("takes the client address from a trusted proxy's X-Forwarded-For", async () => {
  await app.inject({
    method: "GET",
    url: "/health",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  expect(seen.at(-1)).toBe("203.0.113.9");
  // An untrusted peer cannot claim another address.
  await app.inject({
    method: "GET",
    url: "/health",
    remoteAddress: "198.51.100.7",
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  expect(seen.at(-1)).toBe("198.51.100.7");
});
