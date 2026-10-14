// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-028: with no BRIEF_SIGNING_KEY, share links must not be signed with a key anyone knows. */
import { createHmac } from "node:crypto";

import Fastify from "fastify";
import { expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.ts", () => ({
  requireAuth: async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  },
}));
delete process.env.DATABASE_URL;
delete process.env.BRIEF_SIGNING_KEY;
process.env.NEXUS_API_KEY = "brief-share-key-test-master-key";

const { briefRoutes } = await import("../../src/routes/brief.ts");

it("refuses links signed with the old public defaults and honours its own", async () => {
  const app = Fastify();
  await app.register(briefRoutes);
  const date = "2026-09-28";
  await app.inject({
    method: "POST",
    url: "/brief/tech/events",
    headers: { "x-user": "alice" },
    payload: { date, events: [{ id: "e1", summary: "alice private memo" }] },
  });

  for (const known of ["dev-key", "nexus-default-secret"]) {
    const sig = createHmac("sha256", known).update(`alice:${date}`).digest("hex");
    const forged = await app.inject({
      method: "GET",
      url: `/brief/tech/share/x?userId=alice&date=${date}&sig=${sig}`,
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.body).not.toContain("private memo");
  }

  const own = await app.inject({
    method: "GET",
    url: `/brief/tech?date=${date}`,
    headers: { "x-user": "alice" },
  });
  const shareUrl = new URL(own.json<{ shareUrl: string }>().shareUrl);
  const shared = await app.inject({
    method: "GET",
    url: `/brief/tech/share/x${shareUrl.search}`,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  expect(shared.body).toContain("private memo");
});
