// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-018: a host terminal session is visible and writable only by the account that started it. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.NEXUS_EXEC_MODE = "trusted";
process.env.NEXUS_EXEC_ALLOW = "node";
process.env.NEXUS_DESKTOP = "1";

const { localPtyRoutes } = await import("../../src/routes/local-pty.ts");

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", async (req) => {
        req.nexusUserId = req.headers["x-user"] as string;
      });
      await scope.register(localPtyRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
});

afterAll(async () => {
  delete process.env.NEXUS_EXEC_MODE;
  delete process.env.NEXUS_EXEC_ALLOW;
  delete process.env.NEXUS_DESKTOP;
  await app.close();
});

const as = (user: string) => ({ "x-user": user });

it("keeps one account's terminal away from another", async () => {
  const spawned = await app.inject({
    method: "POST",
    url: "/api/local/pty",
    headers: as("alice"),
    payload: { command: "node", args: ["-e", "setTimeout(() => {}, 20000)"] },
  });
  expect(spawned.statusCode, spawned.body).toBe(201);
  const id = spawned.json<{ session: { id: string } }>().session.id;

  const bobList = await app.inject({ method: "GET", url: "/api/local/pty", headers: as("bob") });
  expect(bobList.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id)).not.toContain(
    id,
  );

  for (const [method, url, payload] of [
    ["POST", `/api/local/pty/${id}/write`, { data: "process.exit()\n" }],
    ["POST", `/api/local/pty/${id}/resize`, { cols: 100, rows: 30 }],
    ["DELETE", `/api/local/pty/${id}`, undefined],
  ] as const) {
    const res = await app.inject({ method, url, headers: as("bob"), payload });
    expect(res.statusCode, `${method} ${url}`).toBe(404);
  }

  const aliceList = await app.inject({
    method: "GET",
    url: "/api/local/pty",
    headers: as("alice"),
  });
  expect(aliceList.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id)).toContain(id);
  const del = await app.inject({
    method: "DELETE",
    url: `/api/local/pty/${id}`,
    headers: as("alice"),
  });
  expect(del.statusCode).toBe(200);
});
