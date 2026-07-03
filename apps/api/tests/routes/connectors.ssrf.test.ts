// SPDX-License-Identifier: Apache-2.0
/**
 * §9.1: the OAuth token-exchange call in connectors.ts (GET
 * /connectors/:id/oauth/callback) must go through `pinnedFetch`, not the raw
 * global `fetch` — the request is user-triggered (attacker controls when the
 * callback fires) even though the token URL itself is fixed per-provider
 * config. This asserts the route calls the pinned-fetch module, and that a
 * pinnedFetch rejection (as it would reject a DNS-rebound host) surfaces as a
 * clean 502 rather than an unhandled error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

const pinnedFetchMock = vi.fn();
vi.mock("../../src/lib/pinned-fetch.js", () => ({
  pinnedFetch: (...args: unknown[]) => pinnedFetchMock(...args),
}));

describe("GET /connectors/:id/oauth/callback — pinned-fetch sink", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.GITHUB_CLIENT_ID = "gh-client-id";
    process.env.GITHUB_CLIENT_SECRET = "gh-client-secret";
    pinnedFetchMock.mockReset();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  async function getState(): Promise<string> {
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/connectors/github/oauth/start",
      headers: { authorization: "Bearer test" },
    });
    expect(start.statusCode).toBe(200);
    return start.json<{ state: string }>().state;
  }

  it("routes the token exchange through pinnedFetch, not global fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    pinnedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "gho_mock" }),
    });

    const state = await getState();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/connectors/github/oauth/callback?code=abc123&state=${state}`,
    });

    expect(res.statusCode).toBe(200);
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(pinnedFetchMock.mock.calls[0]?.[0]).toBe("https://github.com/login/oauth/access_token");
    expect(globalFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("surfaces a pinnedFetch rejection (e.g. DNS-rebind block) as a clean 502", async () => {
    pinnedFetchMock.mockRejectedValue(
      new Error("pinnedFetch: destination resolved to a private address"),
    );

    const state = await getState();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/connectors/github/oauth/callback?code=abc123&state=${state}`,
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain("Token exchange network error");
  });
});
