// SPDX-License-Identifier: Apache-2.0
/** Scenarios belong to their author, and deleting one removes it. */
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  },
}));

const { scenarioPlannerRoutes } = await import("../../src/routes/scenario-planner.js");

it("keeps scenarios to their author and deletes for real", async () => {
  const app = Fastify();
  await app.register(scenarioPlannerRoutes);
  const as = (user: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: { "x-user": user }, ...(payload ? { payload } : {}) });

  const made = await as("alice", "POST", "/scenarios", {
    name: "alice acquisition plan",
    outcomes: [{ name: "win", probability: 1, impact: 5 }],
  });
  expect(made.statusCode).toBe(201);
  const { id } = made.json<{ id: string }>();

  expect((await as("bob", "GET", "/scenarios")).body).not.toContain("acquisition");
  expect((await as("bob", "GET", "/scenarios/plan/rank")).body).not.toContain("acquisition");
  expect((await as("bob", "GET", `/scenarios/${id}`)).statusCode).toBe(404);
  expect((await as("bob", "DELETE", `/scenarios/${id}`)).statusCode).toBe(404);

  expect((await as("alice", "DELETE", `/scenarios/${id}`)).statusCode).toBe(200);
  expect((await as("alice", "GET", `/scenarios/${id}`)).statusCode).toBe(404);
  expect((await as("alice", "GET", "/scenarios")).json()).toMatchObject({ total: 0 });
});
