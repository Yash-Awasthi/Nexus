// SPDX-License-Identifier: Apache-2.0
/** Rated responses belong to the account that rated them, whatever userId a caller names. */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  },
}));

const { rlhfRoutes } = await import("../../src/routes/rlhf.js");

describe("rlhf feedback", () => {
  it("is private to its account", async () => {
    const app = Fastify();
    await app.register(rlhfRoutes);
    const as = (user: string, method: "GET" | "POST", url: string, payload?: object) =>
      app.inject({ method, url, headers: { "x-user": user }, ...(payload ? { payload } : {}) });

    const rated = await as("alice", "POST", "/rlhf/feedback", {
      sessionId: "s1",
      messageId: "m1",
      promptText: "alice's private prompt",
      responseText: "alice's private answer",
      model: "m",
      rating: "thumbs_up",
      userId: "bob",
    });
    expect(rated.statusCode).toBe(201);

    for (const url of [
      "/rlhf/feedback",
      "/rlhf/feedback?userId=alice",
      "/rlhf/export/feedback",
      "/rlhf/reward/s1",
    ]) {
      const res = await as("bob", "GET", url);
      expect(res.body, url).not.toContain("private");
      expect(res.body, url).not.toContain('"totalFeedback":1');
    }
    expect((await as("bob", "GET", "/rlhf/stats")).json()).toMatchObject({ totalFeedback: 0 });
    expect((await as("alice", "GET", "/rlhf/feedback")).json()).toMatchObject({ total: 1 });
  });
});
