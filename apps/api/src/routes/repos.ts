// SPDX-License-Identifier: Apache-2.0
/**
 * Repos surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * GitHub repo listing + code search. Calls the GitHub REST API when
 * GITHUB_TOKEN is set; the listing is TTL-cached (10 min) to avoid burning the
 * 5000 req/hr authenticated rate limit on UI polling. Response shapes are
 * byte-identical to the pre-extraction /repos/* handlers.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 *
 * Known dead branch (kept byte-identical for the extraction): the
 * tree-fallback in /repos/:id/search is unreachable — with GITHUB_TOKEN unset
 * `_listGithubRepos` returns [] before the cache check (→ 404), and with a
 * token the code-search branch always returns. Candidate for a follow-up
 * cleanup slice.
 */

import type { FastifyInstance } from "fastify";

const now = (): string => new Date().toISOString();

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  stargazers_count: number;
  updated_at: string;
  language: string | null;
  default_branch: string;
}

// Repo transform extracted to eliminate copy-paste between /repos and /repos/github
function _toRepoView(r: GhRepo) {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    url: r.html_url,
    description: r.description,
    private: r.private,
    stars: r.stargazers_count,
    updatedAt: r.updated_at,
    language: r.language,
    defaultBranch: r.default_branch,
  };
}

let _repoCache: { data: GhRepo[]; expiresAt: number } | null = null;
const REPO_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function _listGithubRepos(): Promise<GhRepo[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];
  if (_repoCache && Date.now() < _repoCache.expiresAt) return _repoCache.data;
  try {
    const res = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return _repoCache?.data ?? [];
    const data = (await res.json()) as GhRepo[];
    _repoCache = { data, expiresAt: Date.now() + REPO_TTL_MS };
    return data;
  } catch {
    return _repoCache?.data ?? []; // return stale on timeout/error
  }
}

/** Register the /repos/* surface. Called from apiBridgeRoutes. */
export async function reposRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos", async (_req, reply) => {
    const repos = await _listGithubRepos();
    if (repos.length === 0 && !process.env.GITHUB_TOKEN) {
      return reply.send({ repos: [], message: "Set GITHUB_TOKEN to list repos." });
    }
    return reply.send({ repos: repos.map(_toRepoView) });
  });

  app.get("/repos/github", async (_req, reply) => {
    return reply.send({ repos: (await _listGithubRepos()).map(_toRepoView) });
  });

  /**
   * POST /repos/:id/search — search files in a repo via GitHub Code Search API.
   * When GITHUB_TOKEN is set, uses the real GitHub Search API; otherwise falls back
   * to a basic local search of the repo's file listing.
   *
   * Body: { query: string, path?: string, maxResults?: number }
   */
  app.post<{
    Params: { id: string };
    Body: { query: string; path?: string; maxResults?: number };
  }>(
    "/repos/:id/search",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", maxLength: 512 },
            path: { type: "string", maxLength: 256 },
            maxResults: { type: "number", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { query, path: searchPath = "/", maxResults = 10 } = request.body;
      const repoId = request.params.id;
      const ghToken = process.env.GITHUB_TOKEN;

      // Find the repo's full_name from the cached list
      const repos = await _listGithubRepos();
      const repo = repos.find(
        (r) => String(r.id) === repoId || r.name === repoId || r.full_name === repoId,
      );

      if (!repo) {
        return reply.code(404).send({ error: "repo_not_found", repoId });
      }

      if (ghToken) {
        // Real GitHub Code Search API
        try {
          const qualifiers = [`repo:${repo.full_name}`];
          if (searchPath && searchPath !== "/") {
            qualifiers.push(`path:${searchPath}`);
          }
          const searchQuery = `${query} ${qualifiers.join(" ")}`;
          const url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${Math.min(maxResults, 30)}`;

          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!res.ok) {
            const errBody = await res.text();
            app.log.warn({ status: res.status, body: errBody }, "GitHub code search failed");
            return reply.send({
              repoId,
              query,
              hits: [],
              total: 0,
              searchedAt: now(),
              source: "github-api",
              error: `GitHub API returned ${res.status}`,
            });
          }

          const data = (await res.json()) as {
            total_count: number;
            items: Array<{
              name: string;
              path: string;
              text_matches?: Array<{
                fragment: string;
                matches?: Array<{ indices: number[]; text: string }>;
              }>;
            }>;
          };

          const hits = (data.items ?? []).slice(0, maxResults).map((item) => {
            const match = item.text_matches?.[0]?.fragment ?? "";
            // Extract line number from text_matches if available
            const lineMatch = item.text_matches?.[0]?.matches?.[0];
            const indices = (lineMatch?.indices as number[] | undefined) ?? [];
            return {
              file: item.path,
              line: indices[0] ?? 0,
              match: match.slice(0, 500),
              score: 0.9,
            };
          });

          return reply.send({
            repoId,
            query,
            hits,
            total: data.total_count ?? hits.length,
            searchedAt: now(),
            source: "github-api",
          });
        } catch (err) {
          app.log.error({ err }, "GitHub code search error");
          return reply.send({
            repoId,
            query,
            hits: [],
            total: 0,
            searchedAt: now(),
            source: "github-api",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Fallback: search through the repo's file tree via GitHub Trees API
      try {
        const treeUrl = `https://api.github.com/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`;
        const treeRes = await fetch(treeUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
          },
        });

        if (!treeRes.ok) {
          return reply.send({
            repoId,
            query,
            hits: [],
            total: 0,
            searchedAt: now(),
            source: "tree-fallback",
            error: `GitHub trees API returned ${treeRes.status}`,
          });
        }

        const treeData = (await treeRes.json()) as {
          tree: Array<{ path: string; type: string; size?: number }>;
        };

        const queryLower = query.toLowerCase();
        const hits = (treeData.tree ?? [])
          .filter((item) => item.type === "blob")
          .filter((item) => {
            const p =
              searchPath === "/" ? true : item.path.startsWith(searchPath.replace(/^\//, ""));
            return p;
          })
          .filter((item) => item.path.toLowerCase().includes(queryLower))
          .slice(0, maxResults)
          .map((item) => ({
            file: item.path,
            line: 0,
            match: `File: ${item.path} (${item.size ?? 0} bytes)`,
            score: item.path.toLowerCase() === queryLower ? 1.0 : 0.7,
          }));

        return reply.send({
          repoId,
          query,
          hits,
          total: hits.length,
          searchedAt: now(),
          source: "tree-fallback",
        });
      } catch (err) {
        app.log.error({ err }, "Tree search fallback error");
        return reply.send({
          repoId,
          query,
          hits: [],
          total: 0,
          searchedAt: now(),
          source: "tree-fallback",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /** GET /repos/:id/status — repo metadata and sync status. */
  app.get<{ Params: { id: string } }>("/repos/:id/status", async (request, reply) => {
    const repoId = request.params.id;
    return reply.send({
      id: repoId,
      name: repoId,
      status: "synced",
      lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
      branchCount: 3,
      defaultBranch: "main",
      sizeKb: 1_280,
      provider: "github",
    });
  });
}