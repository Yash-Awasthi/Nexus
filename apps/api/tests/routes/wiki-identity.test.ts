// SPDX-License-Identifier: Apache-2.0
/** Wiki drafts, comments and access grants act as the caller, never as a name the client sends. */
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  },
}));
delete process.env.DATABASE_URL;

const { wikiRoutes } = await import("../../src/routes/wiki.js");

it("ties drafts, comments and grants to the caller", async () => {
  const app = Fastify();
  await app.register(wikiRoutes);
  const as = (user: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: { "x-user": user }, ...(payload ? { payload } : {}) });

  const draft = await as("alice", "POST", "/wiki/drafts", {
    authorId: "bob",
    title: "alice private draft",
    content: "x",
  });
  expect(draft.statusCode).toBe(201);
  const { id, authorId } = draft.json<{ id: string; authorId: string }>();
  expect(authorId).toBe("alice");
  expect((await as("bob", "GET", "/wiki/drafts?authorId=alice")).body).not.toContain("private");
  expect((await as("bob", "GET", `/wiki/drafts/${id}`)).statusCode).toBe(404);
  await as("bob", "DELETE", `/wiki/drafts/${id}`);
  expect((await as("alice", "GET", `/wiki/drafts/${id}`)).statusCode).toBe(200);

  const comment = await as("alice", "POST", "/wiki/articles/p1/comments", {
    authorId: "bob",
    content: "hi",
  });
  expect(comment.json<{ authorId: string }>().authorId).toBe("alice");

  // The first grant on a page makes its granter the owner; after that only owners grant.
  const first = await as("alice", "POST", "/wiki/articles/p1/acl", {
    userId: "carol",
    role: "viewer",
    grantedBy: "bob",
  });
  expect(first.json<{ grantedBy: string }>().grantedBy).toBe("alice");
  const stolen = await as("mallory", "POST", "/wiki/articles/p1/acl", {
    userId: "mallory",
    role: "owner",
    grantedBy: "alice",
  });
  expect(stolen.statusCode).toBe(403);
  expect((await as("mallory", "DELETE", "/wiki/articles/p1/acl/alice")).statusCode).toBe(403);
});
