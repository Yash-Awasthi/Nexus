// SPDX-License-Identifier: Apache-2.0
/**
 * Two envelopes, one writer each. The tests are here because the shape is a contract:
 * an OpenAI client parses `error.type`, a dashboard reads `error` as a string, and a
 * refactor that swaps them would still compile.
 */
import { describe, expect, it } from "vite-plus/test";

import { fail, gatewayError, openaiError } from "../../src/lib/reply-errors.ts";

/** A reply that records what was sent, at which status. */
function reply() {
  const sent: { status: number; body: unknown }[] = [];
  return {
    sent,
    code(status: number) {
      return { send: (body: unknown) => sent.push({ status, body }) };
    },
    send: (body: unknown) => sent.push({ status: 200, body }),
  };
}

describe("the Nexus envelope", () => {
  it("writes a code and nothing else by default", () => {
    const r = reply();
    fail(r, 404, "user_not_found");
    expect(r.sent).toEqual([{ status: 404, body: { error: "user_not_found" } }]);
  });

  it("carries extra fields beside the code, not inside it", () => {
    const r = reply();
    fail(r, 400, "invalid_budget", { message: "must be positive", limit: 0 });
    expect(r.sent[0]?.body).toEqual({
      error: "invalid_budget",
      message: "must be positive",
      limit: 0,
    });
  });
});

describe("the /v1 envelope", () => {
  it("matches what an SDK client parses: a bare error object", () => {
    const r = reply();
    openaiError(r, 400, "invalid_request_error", "model and messages are required");
    expect(r.sent).toEqual([
      {
        status: 400,
        body: {
          error: { type: "invalid_request_error", message: "model and messages are required" },
        },
      },
    ]);
  });

  it("keeps `code` when the route has one, because clients branch on it", () => {
    const r = reply();
    openaiError(r, 402, "spend_cap_exceeded", "over", { total_usd: 1.5, code: null });
    expect(r.sent[0]?.body).toEqual({
      error: { type: "spend_cap_exceeded", message: "over", total_usd: 1.5, code: null },
    });
  });
});

describe("the gateway envelope", () => {
  it("adds the `type: error` discriminator the gateway's callers already read", () => {
    const r = reply();
    gatewayError(r, 503, "provider_unavailable", "no healthy account");
    expect(r.sent[0]?.body).toEqual({
      type: "error",
      error: { type: "provider_unavailable", message: "no healthy account" },
    });
  });
});
