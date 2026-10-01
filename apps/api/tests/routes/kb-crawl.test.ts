// SPDX-License-Identifier: Apache-2.0
/** A knowledge base can take in a website: each crawled page becomes one document. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const importSite = vi.fn(async (_url: string, _opts: { maxPages: number }) => ({
  pages: [
    { url: "https://docs.example.com/guide", title: "Guide", text: "Install with one command." },
    { url: "https://docs.example.com/faq", title: "FAQ", text: "Backups run nightly." },
  ],
  disallowed: 2,
}));
vi.mock("../../src/lib/site-import.js", () => ({ importSite }));

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  // Document chunks go to the in-process memory store.
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("stores each crawled page as a document and reports what robots.txt kept out", async () => {
  const kb = await app.inject({
    method: "POST",
    url: "/api/kb",
    payload: { name: `crawl-${Date.now()}` },
  });
  const id = kb.json<{ id: string }>().id;

  const r = await app.inject({
    method: "POST",
    url: `/api/kb/${id}/crawl`,
    payload: { url: "https://docs.example.com/", maxPages: 500 },
  });
  expect(r.statusCode, r.body).toBe(201);
  expect(r.json()).toMatchObject({ added: 2, disallowed: 2 });
  expect(importSite).toHaveBeenCalledWith(
    "https://docs.example.com/",
    expect.objectContaining({ maxPages: 25 }),
  );

  const docs = await app.inject({ method: "GET", url: `/api/kb/${id}/documents` });
  expect(docs.body).toContain("Guide");
  expect(docs.body).toContain("FAQ");
});

it("refuses a private or malformed address before crawling", async () => {
  const kb = await app.inject({
    method: "POST",
    url: "/api/kb",
    payload: { name: `crawl2-${Date.now()}` },
  });
  const id = kb.json<{ id: string }>().id;
  importSite.mockClear();
  for (const url of ["http://127.0.0.1:3999/", "not a url"]) {
    const r = await app.inject({ method: "POST", url: `/api/kb/${id}/crawl`, payload: { url } });
    expect(r.statusCode, r.body).toBe(400);
  }
  expect(importSite).not.toHaveBeenCalled();
});
