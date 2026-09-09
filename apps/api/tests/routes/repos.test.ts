// SPDX-License-Identifier: Apache-2.0
/**
 * Repos surface route tests — the §16.7 extraction of /repos/* from
 * api-bridge.ts into routes/repos.ts.
 *
 * Hermetic: the GitHub REST calls are stubbed via a URL-aware global fetch
 * stub (the listing endpoint, the code-search endpoint, and the trees
 * endpoint). NOTE on ordering: the module-level 10-min repo cache is shared
 * across tests in this file — the no-token guard tests must run FIRST, before
 * a token-backed test warms the cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.GITHUB_TOKEN;
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

/** Minimal fetch-like response for the stub. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const REPOS_PAYLOAD = [
  {
    id: 1,
    name: "nexus",
    full_name: "acme/nexus",
    html_url: "https://github.com/acme/nexus",
    description: "The platform",
    private: false,
    stargazers_count: 42,
    updated_at: "2026-09-01T00:00:00Z",
    language: "TypeScript",
    default_branch: "main",
  },
  {
    id: 2,
    name: "docs",
    full_name: "acme/docs",
    html_url: "https://github.com/acme/docs",
    description: null,
    private: true,
    stargazers_count: 0,
    updated_at: "2026-08-15T00:00:00Z",
    language: null,
    default_branch: "master",
  },
];

interface RepoView {
  id: number;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  private: boolean;
  stars: number;
  updatedAt: string;
  language: string | null;
  defaultBranch: string;
}

describe("GET /api/repos (no GITHUB_TOKEN — guard paths)", () => {
  it("/repos returns the empty list with the setup hint", async () => {
    const res = await app.inject({ method: "GET", url: "/api/repos" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      repos: [],
      message: "Set GITHUB_TOKEN to list repos.",
    });
  });

  it("/repos/github returns an empty list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/repos/github" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repos: [] });
  });

  it("POST /repos/:id/search → 404 repo_not_found when the repo is unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos/999/search",
      payload: { query: "anything" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "repo_not_found", repoId: "999" });
  });

  it("GET /repos/:id/status returns the static synced shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/repos/nexus/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string; provider: string }>();
    expect(body.id).toBe("nexus");
    expect(body.status).toBe("synced");
    expect(body.provider).toBe("github");
  });
});

describe("GET /api/repos (GITHUB_TOKEN + stubbed GitHub API)", () => {
  it("/repos lists mapped repo views (camelCase transform, byte-identical)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(REPOS_PAYLOAD)));
    process.env.GITHUB_TOKEN = "test-token";

    const res = await app.inject({ method: "GET", url: "/api/repos" });
    expect(res.statusCode).toBe(200);
    const repos = res.json<{ repos: RepoView[] }>().repos;
    expect(repos).toHaveLength(2);

    const nexus = repos[0]!;
    expect(nexus).toEqual({
      id: 1,
      name: "nexus",
      fullName: "acme/nexus",
      url: "https://github.com/acme/nexus",
      description: "The platform",
      private: false,
      stars: 42,
      updatedAt: "2026-09-01T00:00:00Z",
      language: "TypeScript",
      defaultBranch: "main",
    });
    expect(repos[1]!.defaultBranch).toBe("master");
    expect(repos[1]!.private).toBe(true);
  });

  it("POST /repos/:id/search uses the GitHub code-search API when a token is set", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/search/code")) {
          return jsonResponse({
            total_count: 2,
            items: [
              {
                name: "a.ts",
                path: "src/a.ts",
                text_matches: [
                  { fragment: "const x = 1", matches: [{ indices: [6, 7], text: "x" }] },
                ],
              },
            ],
          });
        }
        // Repo listing (warm the cache).
        return jsonResponse(REPOS_PAYLOAD);
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/nexus/search",
      payload: { query: "const", maxResults: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      repoId: string;
      source: string;
      total: number;
      hits: { file: string; line: number; match: string; score: number }[];
    }>();
    expect(body.source).toBe("github-api");
    expect(body.repoId).toBe("nexus");
    expect(body.total).toBe(2);
    expect(body.hits).toEqual([{ file: "src/a.ts", line: 6, match: "const x = 1", score: 0.9 }]);
  });

  // NOTE: the handler's tree-fallback branch (source: "tree-fallback") is NOT
  // tested — it is unreachable: _listGithubRepos returns [] before the cache
  // check when GITHUB_TOKEN is unset (→ 404 repo_not_found), and with a token
  // the code-search branch always returns. Legacy-dead code, kept byte-identical
  // for the extraction; flagged in routes/repos.ts for a follow-up cleanup.
});
