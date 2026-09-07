// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
/**
 * Focused tests for the deliberate.ts thread bridge (API-first with a
 * localStorage fallback): the ghost-thread migration that keeps the server the
 * single truth, and the offline fallback itself.
 *
 * Regression: threads created while the API was unreachable lived only in
 * localStorage and permanently shadowed the (empty) server list — the UI
 * showed "server-backed" rows that were actually per-browser. listThreads must
 * push those ghosts to the server on the first successful contact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listThreads } from "./deliberate";

const THREADS_KEY = "nexus_threads";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("deliberate thread bridge", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("pushes localStorage ghosts to the server and returns the merged list", async () => {
    localStorage.setItem(
      THREADS_KEY,
      JSON.stringify([
        { id: "g1", title: "ghost one", updated_at: 1000, mode: "council" },
        { id: "g2", title: "ghost two", updated_at: 2000 },
      ]),
    );
    const posts: Array<{ id: string; title: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/threads" && (!init?.method || init.method === "GET")) {
        return jsonResponse(200, { threads: [] });
      }
      if (url === "/api/threads" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as { id: string; title: string });
        return jsonResponse(201, {});
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const threads = await listThreads();

    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.id).sort()).toEqual(["g1", "g2"]);
    expect(posts[0]?.title).toBe("ghost one");
    // Both ghosts stay visible in the same load.
    expect(threads.map((t) => t.id).sort()).toEqual(["g1", "g2"]);
  });

  it("does not re-migrate threads the server already knows", async () => {
    localStorage.setItem(
      THREADS_KEY,
      JSON.stringify([{ id: "g1", title: "ghost", updated_at: 1000 }]),
    );
    const posts: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/threads" && (!init?.method || init.method === "GET")) {
        return jsonResponse(200, {
          threads: [{ id: "g1", title: "ghost", updatedAt: "2026-01-01T00:00:00Z" }],
        });
      }
      if (init?.method === "POST") {
        posts.push(1);
        return jsonResponse(201, {});
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const threads = await listThreads();
    expect(posts).toHaveLength(0);
    expect(threads.map((t) => t.id)).toEqual(["g1"]);
  });

  it("merges ghosts with existing server threads", async () => {
    localStorage.setItem(
      THREADS_KEY,
      JSON.stringify([{ id: "g1", title: "ghost", updated_at: 1000 }]),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/threads" && (!init?.method || init.method === "GET")) {
        return jsonResponse(200, {
          threads: [{ id: "s1", title: "server", updatedAt: "2026-01-02T00:00:00Z" }],
        });
      }
      if (init?.method === "POST") return jsonResponse(201, {});
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const threads = await listThreads();
    expect(threads.map((t) => t.id).sort()).toEqual(["g1", "s1"]);
  });

  it("falls back to localStorage when the API is unreachable", async () => {
    localStorage.setItem(
      THREADS_KEY,
      JSON.stringify([{ id: "g1", title: "ghost", updated_at: 1000 }]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const threads = await listThreads();
    expect(threads.map((t) => t.id)).toEqual(["g1"]);
  });
});
