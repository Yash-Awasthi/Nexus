// SPDX-License-Identifier: Apache-2.0
/**
 * The tool-call failure taxonomy (plan M5.3.3).
 *
 * Four failures that a model must react to differently — a timeout, a schema rejection, a 429 and a
 * cut-off stream — plus the two the tree already had (a permission refusal and a missing target).
 * Each case asserts the class, whether a repeat could work, the number the user is told to wait and
 * the sentence a person reads. The last test drives the real `RuntimeToolSet`, because the
 * classifier is only useful if the seam that produces every tool failure actually fills it in.
 */
import { describe, it, expect } from "vite-plus/test";

import { RuntimeToolSet, classifyToolFailure } from "../../src/runtime/index.ts";

describe("classifyToolFailure", () => {
  const cases: {
    name: string;
    error: unknown;
    kind: string;
    retryable: boolean;
    message: RegExp;
    retryAfterMs?: number;
  }[] = [
    {
      name: "a script that was killed at the deadline",
      error: new Error("script timed out after 60000ms"),
      kind: "timeout",
      retryable: true,
      message: /took too long .*check before retrying/i,
    },
    {
      name: "an HTTP client deadline",
      error: Object.assign(new Error("connect ETIMEDOUT 10.0.0.4:443"), { code: "ETIMEDOUT" }),
      kind: "timeout",
      retryable: true,
      message: /took too long/i,
    },
    {
      name: "an arguments rejection",
      error: new Error("ZodError: expected string at path query, received number"),
      kind: "schema",
      retryable: false,
      message: /rejected its arguments: ZodError/i,
    },
    {
      name: "a missing required field",
      error: new Error("missing required property 'path'"),
      kind: "schema",
      retryable: false,
      message: /rejected its arguments/i,
    },
    {
      name: "a 429 with a Retry-After header",
      error: new Error("429 Too Many Requests (retry-after: 30)"),
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 30_000,
      message: /rate limited\. Try again in 30s/i,
    },
    {
      name: "a 429 without a number",
      error: new Error("provider is rate limiting this account"),
      kind: "rate_limited",
      retryable: true,
      message: /rate limited\. Wait a moment/i,
    },
    {
      name: "a stream that closed mid-JSON",
      error: new Error("Unexpected end of JSON input"),
      kind: "partial_stream",
      retryable: true,
      message: /cut off before it finished/i,
    },
    {
      name: "a stream reset by the peer",
      error: new Error("premature close"),
      kind: "partial_stream",
      retryable: true,
      message: /cut off before it finished/i,
    },
    {
      name: "a refused permission",
      error: new Error("permission_denied: the operator declined"),
      kind: "permission",
      retryable: false,
      message: /needs approval before it can run/i,
    },
    {
      name: "a missing file",
      error: new Error("ENOENT: no such file or directory, open 'src/gone.ts'"),
      kind: "not_found",
      retryable: false,
      message: /could not find what it was asked for/i,
    },
    {
      name: "something nobody classified",
      error: new Error("kaboom"),
      kind: "unknown",
      retryable: false,
      message: /failed: kaboom\./i,
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.name}`, () => {
      const failure = classifyToolFailure("run_command", c.error);
      expect(failure.kind).toBe(c.kind);
      expect(failure.retryable).toBe(c.retryable);
      expect(failure.userMessage).toMatch(c.message);
      if (c.retryAfterMs === undefined) expect(failure.retryAfterMs).toBeUndefined();
      else expect(failure.retryAfterMs).toBe(c.retryAfterMs);
      // The tool's own words survive, because the model still needs them.
      expect(failure.detail.length).toBeGreaterThan(0);
    });
  }

  it("keeps a stack trace out of the headline and clips a runaway sentence", () => {
    const failure = classifyToolFailure(
      "fetch_page",
      new Error(`failed: ${"x".repeat(400)}\n    at handler (tools.ts:1:1)`),
    );
    expect(failure.userMessage.length).toBeLessThanOrEqual(200);
    expect(failure.userMessage).not.toContain("at handler");
    expect(failure.detail).toContain("at handler");
  });
});

describe("RuntimeToolSet.invoke", () => {
  it("fills in the failure for every throwing tool and leaves the raw error intact", async () => {
    const set = new RuntimeToolSet();
    set.add({
      name: "flaky_http",
      description: "always 429",
      tier: "read_only",
      handler: async () => {
        throw new Error("429 Too Many Requests (retry-after: 5)");
      },
    });

    const result = await set.invoke("flaky_http", {});

    expect(result.output).toBeNull();
    expect(result.error).toBe("429 Too Many Requests (retry-after: 5)");
    expect(result.failure?.kind).toBe("rate_limited");
    expect(result.failure?.retryAfterMs).toBe(5_000);
    expect(result.failure?.userMessage).toMatch(/Try again in 5s/);
  });

  it("classifies an unknown tool as not_found rather than leaving a bare string", async () => {
    const set = new RuntimeToolSet();
    const result = await set.invoke("does_not_exist", {});
    expect(result.error).toContain("Tool not found");
    expect(result.failure?.kind).toBe("not_found");
  });

  it("does not attach a failure to a call that worked", async () => {
    const set = new RuntimeToolSet();
    set.add({
      name: "ok",
      description: "fine",
      tier: "read_only",
      handler: async () => "done",
    });
    const result = await set.invoke("ok", {});
    expect(result.output).toBe("done");
    expect(result.failure).toBeUndefined();
  });
});
