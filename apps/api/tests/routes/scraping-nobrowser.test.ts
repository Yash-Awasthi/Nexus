// SPDX-License-Identifier: Apache-2.0
/** Without a browser engine, the scraping endpoints say so instead of returning a canned page. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

delete process.env.STEALTH_BROWSER_URL;
vi.mock("@nexus/stealth-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/stealth-browser")>()),
  isPatchrightAvailable: async () => false,
}));

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("scraping without a browser", () => {
  it("refuses instead of inventing a page", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/scraping/fetch",
      headers: { authorization: "Bearer test" },
      payload: { url: "https://example.com/" },
    });
    expect(r.statusCode, r.body).not.toBe(200);
    expect(r.statusCode).not.toBe(404);
    expect(r.body).not.toContain("stub");
    expect(r.body).toMatch(/browser/i);
  });
});
