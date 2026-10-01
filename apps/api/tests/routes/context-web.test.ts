// SPDX-License-Identifier: Apache-2.0
/**
 * The chat composer's `@web` picker quotes what this returns into a deliberation, so every source
 * must come from a search. With no key it searches DuckDuckGo; when nothing answers it says so.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.TAVILY_API_KEY;
  delete process.env.SEARXNG_URL;
  delete process.env.EXA_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.SERPER_API_KEY;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/context/web", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("quotes only what the search returned", async () => {
    const page = `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://fastify.dev/")}">Fastify</a><a class="result__snippet" href="#">Fast web framework</a>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(page)),
    );
    const res = await app.inject({ method: "GET", url: "/api/context/web?q=fastify" });

    expect(res.json()).toEqual([
      {
        title: "Fastify",
        url: "https://fastify.dev/",
        snippet: "Fast web framework",
        provider: "duckduckgo",
      },
    ]);
  });

  it("returns no results and says so when no search answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const res = await app.inject({ method: "GET", url: "/api/context/web?q=fastify" });

    const body = JSON.parse(res.payload) as { results?: unknown[]; message?: string };
    expect(body.results).toEqual([]);
    expect(body.message).toContain("No search provider answered");
  });

  it("answers an empty query with an empty list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/context/web?q=" });

    expect(JSON.parse(res.payload)).toEqual([]);
  });
});
