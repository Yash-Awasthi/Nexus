// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Polyfill global fetch with a mock
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * Helper: build a mock Response with JSON body and optional status.
 */
function mockResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

/**
 * Helper: build a mock Response with plain text body (non-JSON).
 */
function mockTextResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

describe("api client", () => {
  let api: typeof import("../../src/lib/client.js").api;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Unset env vars to get default behaviour (localhost:3000, no auth)
    vi.stubEnv("NEXUS_API_URL", "http://localhost:3000");
    vi.stubEnv("NEXUS_API_KEY", "");
    // Re-import after resetting modules so module-level constants are re-evaluated
    const mod = await import("../../src/lib/client.js");
    api = mod.api;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("api.health()", () => {
    it("calls GET /health (no /api/v1 prefix)", async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: "ok" }));

      await api.health();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toMatch(/\/health$/);
      expect(url).not.toMatch(/api\/v1/);
    });

    it("returns parsed JSON", async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: "ok" }));
      const result = await api.health();
      expect(result).toEqual({ status: "ok" });
    });
  });

  describe("api.get()", () => {
    it("prepends /api/v1 to the path", async () => {
      mockFetch.mockResolvedValue(mockResponse({ data: [] }));

      await api.get("/signals");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/api/v1/signals");
    });

    it("uses GET method", async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await api.get("/test");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("GET");
    });

    it("sends Accept: application/json header", async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await api.get("/test");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json");
    });
  });

  describe("api.post()", () => {
    it("sends JSON-serialised body", async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: "abc" }));

      await api.post("/council/deliberate", { proposal: "test proposal" });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ proposal: "test proposal" }));
    });

    it("sets Content-Type: application/json", async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await api.post("/test", {});

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });
  });

  describe("error handling", () => {
    it("throws with status code for non-JSON response", async () => {
      mockFetch.mockResolvedValue(mockTextResponse("Internal Server Error", 500));

      await expect(api.get("/bad")).rejects.toThrow(/Non-JSON response/);
    });

    it("throws with error message for HTTP error status and JSON body", async () => {
      mockFetch.mockResolvedValue(mockResponse({ error: "Not found" }, 404));

      await expect(api.get("/missing")).rejects.toThrow(/HTTP 404/);
    });

    it("includes the error field from JSON body in the thrown message", async () => {
      mockFetch.mockResolvedValue(mockResponse({ error: "Unauthorized access" }, 401));

      await expect(api.get("/protected")).rejects.toThrow(/Unauthorized access/);
    });
  });

  describe("Authorization header", () => {
    it("omits Authorization header when NEXUS_API_KEY is empty", async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await api.get("/test");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });

    it("sends Bearer token when NEXUS_API_KEY is set", async () => {
      vi.resetModules();
      vi.stubEnv("NEXUS_API_KEY", "my-test-key");
      const mod = await import("../../src/lib/client.js");
      const apiWithKey = mod.api;

      mockFetch.mockResolvedValue(mockResponse({}));
      await apiWithKey.get("/test");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-test-key");
    });
  });
});
