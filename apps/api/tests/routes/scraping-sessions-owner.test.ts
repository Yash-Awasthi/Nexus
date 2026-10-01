// SPDX-License-Identifier: Apache-2.0
/** A scraping browser session is its opener's: others neither see nor close it. */
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  },
}));
delete process.env.STEALTH_BROWSER_URL;

const { scrapingMcpRoutes } = await import("../../src/routes/scraping-mcp.js");

it("keeps browser sessions to the account that opened them", async () => {
  const app = Fastify();
  await app.register(scrapingMcpRoutes);
  const as = (user: string, method: "GET" | "POST" | "DELETE", url: string) =>
    app.inject({ method, url, headers: { "x-user": user } });

  const opened = await as("alice", "POST", "/scraping/sessions");
  expect(opened.statusCode).toBe(201);
  const { sessionId } = opened.json<{ sessionId: string }>();

  expect((await as("bob", "GET", "/scraping/sessions")).json()).toMatchObject({ count: 0 });
  await as("bob", "DELETE", `/scraping/sessions/${sessionId}`);
  expect((await as("alice", "GET", "/scraping/sessions")).json()).toMatchObject({ count: 1 });
});
