// SPDX-License-Identifier: Apache-2.0
/**
 * Stage B2 — the generated client.
 *
 * The types are checked by the compiler; what needs a test is the runtime
 * behaviour around them: how a path with parameters becomes a URL, what a
 * non-2xx answer turns into, and that an endpoint with no body is not treated
 * as a failure.
 */
import { describe, it, expect, vi } from "vitest";

import { TypedNexusClient, TypedRequestError, buildUrl } from "../src/typed.js";

function respond(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("buildUrl", () => {
  it("fills path parameters and encodes them", () => {
    const url = buildUrl("http://api.test", "/api/v1/council/verdicts/{verdictId}", {
      params: { verdictId: "a b/c" },
    });

    expect(url).toBe("http://api.test/api/v1/council/verdicts/a%20b%2Fc");
  });

  it("names the parameter it is missing", () => {
    expect(() => buildUrl("http://api.test", "/api/v1/council/verdicts/{verdictId}")).toThrow(
      /verdictId/,
    );
  });

  it("appends a query string and drops undefined values", () => {
    const url = buildUrl("http://api.test", "/api/v1/council/verdicts", {
      query: { limit: 10, offset: undefined, includeDrafts: false },
    });

    expect(url).toBe("http://api.test/api/v1/council/verdicts?limit=10&includeDrafts=false");
  });
});

describe("TypedNexusClient", () => {
  it("sends the bearer token and parses the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, JSON.stringify({ verdicts: [] })));
    const client = new TypedNexusClient({
      baseUrl: "http://api.test/",
      token: "jwt",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.get("/api/v1/council/verdicts");

    expect(result).toEqual({ verdicts: [] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/v1/council/verdicts");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer jwt");
  });

  it("sends no Authorization header when it holds no token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, "{}"));
    const client = new TypedNexusClient({ fetch: fetchImpl as unknown as typeof fetch });

    await client.get("/health");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("serialises a POST body as JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, "{}"));
    const client = new TypedNexusClient({ fetch: fetchImpl as unknown as typeof fetch });

    await client.post("/api/v1/council/deliberate", { proposal: { title: "Ship it" } });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ proposal: { title: "Ship it" } });
  });

  it("raises the status and the path on a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(403, '{"error":"forbidden"}'));
    const client = new TypedNexusClient({ fetch: fetchImpl as unknown as typeof fetch });

    const failure = await client.get("/api/v1/council/verdicts").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TypedRequestError);
    expect((failure as TypedRequestError).status).toBe(403);
    expect((failure as TypedRequestError).path).toBe("/api/v1/council/verdicts");
    expect((failure as TypedRequestError).body).toContain("forbidden");
  });

  it("treats an empty body as a result, not an error", async () => {
    // 200 with no body: the Response constructor refuses a body on a 204, and
    // what is being pinned is the empty body, not the status.
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, ""));
    const client = new TypedNexusClient({ fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.get("/health")).resolves.toBeNull();
  });
});
