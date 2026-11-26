// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
/**
 * Chat-stream failure messages. A 429 from the API limiter is a throttle the
 * user can wait out, not a broken turn; the UI must say so and name the
 * Retry-After wait instead of printing "Chat stream failed: 429".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { deliberate, streamErrorMessage } from "./deliberate";

const COUNCIL_KEY = "nexus_council";

describe("streamErrorMessage", () => {
  it("names the retry wait on 429 instead of a failure", () => {
    expect(streamErrorMessage(429, "7")).toBe("API rate limit reached. Try again in 7s.");
    expect(streamErrorMessage(429, "0.2")).toBe("API rate limit reached. Try again in 1s.");
  });

  it("keeps a 429 readable when the server sends no Retry-After", () => {
    expect(streamErrorMessage(429, null)).toBe("API rate limit reached. Try again in a moment.");
  });

  it("surfaces the server message and status for other failures", () => {
    expect(streamErrorMessage(400, null, '{"error":"no_provider_key"}')).toBe(
      "no_provider_key (400)",
    );
    expect(streamErrorMessage(401, null, "not json")).toBe("not json (401)");
    expect(streamErrorMessage(502, null)).toBe("Chat stream failed (502).");
  });
});

describe("deliberate on a throttled stream", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      COUNCIL_KEY,
      JSON.stringify([{ label: "A", provider: "openai", model: "gpt-4o-mini", enabled: true }]),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with the throttle message, not a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "12" },
          }),
      ),
    );

    await expect(deliberate({ threadId: "t1", message: "hi", round: 1 })).rejects.toThrow(
      "API rate limit reached. Try again in 12s.",
    );
  });
});
