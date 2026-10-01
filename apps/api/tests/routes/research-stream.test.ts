// SPDX-License-Identifier: Apache-2.0
/** Every research phase the stream opens is closed again, so a finished run shows no spinner. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Search finds nothing, so the synthesis step takes its no-model path and no call leaves the machine.
vi.mock("../../src/lib/duckduckgo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/duckduckgo.js")>()),
  searchDuckDuckGo: async () => [],
}));

for (const k of Object.keys(process.env))
  if (/_API_KEYS?$|^SEARXNG_URL$/.test(k)) delete process.env[k];

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("closes every phase it opens", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/research",
    payload: { query: "What is the WebAssembly component model?" },
  });
  expect(created.statusCode, created.body).toBeLessThan(300);
  const { id } = created.json<{ id: string }>();
  const stream = await app.inject({ method: "GET", url: `/api/research/${id}/stream` });
  const events = stream.payload
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; phase?: string });

  expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: "done" });
  const opened = events.filter((e) => e.type === "phase_start").map((e) => e.phase);
  const closed = new Set(events.filter((e) => e.type === "phase_done").map((e) => e.phase));
  expect(opened.filter((p) => !closed.has(p))).toEqual([]);
});
