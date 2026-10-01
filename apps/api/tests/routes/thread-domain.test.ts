// SPDX-License-Identifier: Apache-2.0
/**
 * A chat thread's domain focus can be read back and cleared, so the council
 * page can show what steers a conversation and let the user turn it off.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("thread domain", () => {
  it("reads back the applied domain and clears it", async () => {
    const id = crypto.randomUUID();
    const made = await app.inject({
      method: "POST",
      url: "/api/threads",
      payload: { id, title: "Domain test" },
    });
    expect(made.statusCode).toBeLessThan(300);

    const none = await app.inject({ method: "GET", url: `/api/specialisation/thread/${id}` });
    expect(none.json()).toEqual({ domain: null });

    const applied = await app.inject({
      method: "POST",
      url: "/api/specialisation/apply",
      payload: { domain: "devops", sessionId: id },
    });
    expect(applied.statusCode).toBe(200);

    const read = await app.inject({ method: "GET", url: `/api/specialisation/thread/${id}` });
    expect(read.json()).toEqual({ domain: "devops" });

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/specialisation/thread/${id}`,
    });
    expect(cleared.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: `/api/specialisation/thread/${id}` });
    expect(after.json()).toEqual({ domain: null });
  });
});
