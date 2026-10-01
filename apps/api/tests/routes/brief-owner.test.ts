// SPDX-License-Identifier: Apache-2.0
/** A brief is built for the caller; naming another userId reads nothing of theirs. */
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  },
}));
delete process.env.DATABASE_URL;

const { briefRoutes } = await import("../../src/routes/brief.js");

it("keeps each account's brief to that account", async () => {
  const app = Fastify();
  await app.register(briefRoutes);
  const date = "2026-09-28";
  const pushed = await app.inject({
    method: "POST",
    url: "/brief/tech/events",
    headers: { "x-user": "alice" },
    payload: {
      date,
      userId: "bob",
      events: [{ id: "e1", summary: "alice private launch memo" }],
    },
  });
  expect(pushed.statusCode, pushed.body).toBe(201);

  const bob = await app.inject({
    method: "GET",
    url: `/brief/tech?date=${date}&userId=alice`,
    headers: { "x-user": "bob" },
  });
  expect(bob.body).not.toContain("private launch memo");
  const alice = await app.inject({
    method: "GET",
    url: `/brief/tech?date=${date}`,
    headers: { "x-user": "alice" },
  });
  expect(alice.body).toContain("private launch memo");
});
