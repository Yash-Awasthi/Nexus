// SPDX-License-Identifier: Apache-2.0
/**
 * §9.1: the webhook-trigger delivery call in api-bridge.ts (POST
 * /webhooks/:id/trigger) must go through `pinnedFetch`, not the raw global
 * `fetch`. `validateWebhookUrl` only runs at create/update time — a hostname
 * that re-resolves to a private/IMDS address between then and the trigger-time
 * call (DNS rebinding) would bypass that static check, so the live call needs
 * its own socket-pinned defense (same pattern as mcp-servers.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

const pinnedFetchMock = vi.fn();
vi.mock("../../src/lib/pinned-fetch.js", () => ({
  pinnedFetch: (...args: unknown[]) => pinnedFetchMock(...args),
}));

const AUTH_HEADERS = { authorization: "Bearer test" };

describe("POST /webhooks/:id/trigger — pinned-fetch sink", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    pinnedFetchMock.mockReset();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createWebhook(url: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: AUTH_HEADERS,
      payload: { url, events: ["test.event"] },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it("routes webhook delivery through pinnedFetch, not global fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    pinnedFetchMock.mockResolvedValue({ ok: true });

    const id = await createWebhook("https://example.com/hook");
    const res = await app.inject({
      method: "POST",
      url: `/api/webhooks/${id}/trigger`,
      headers: AUTH_HEADERS,
      payload: { event: "test.event", payload: { hello: "world" } },
    });

    expect(res.statusCode).toBe(200);
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(pinnedFetchMock.mock.calls[0]?.[0]).toBe("https://example.com/hook");
    expect(globalFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("delivery failure via pinnedFetch (e.g. DNS-rebind block) is reported as not delivered", async () => {
    pinnedFetchMock.mockRejectedValue(
      new Error("pinnedFetch: destination resolved to a private address"),
    );

    const id = await createWebhook("https://example.com/hook");
    const res = await app.inject({
      method: "POST",
      url: `/api/webhooks/${id}/trigger`,
      headers: AUTH_HEADERS,
      payload: { event: "test.event" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ delivered: boolean }>();
    expect(body.delivered).toBe(false);
  });
});
