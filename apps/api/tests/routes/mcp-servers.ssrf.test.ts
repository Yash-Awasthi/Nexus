// SPDX-License-Identifier: Apache-2.0
/**
 * SSRF regression tests for the MCP server endpoint validator.
 *
 * validateMcpEndpoint() is the single guard both the create and update routes
 * use to stop a user from registering an MCP "server" that points at the API
 * host's own loopback / internal services (SSRF) or at a non-network scheme
 * (file:, gopher:). These assert the attack inputs are rejected, not just that
 * a normal https URL passes.
 */
import { describe, it, expect } from "vitest";

import { validateMcpEndpoint } from "../../src/routes/mcp-servers.js";

describe("validateMcpEndpoint — SSRF guard", () => {
  it("accepts a normal public https endpoint", () => {
    expect(validateMcpEndpoint("https://mcp.example.com/sse")).toBeNull();
  });

  it("accepts a public http endpoint", () => {
    expect(validateMcpEndpoint("http://mcp.example.com:8080")).toBeNull();
  });

  it.each([
    "http://localhost/admin",
    "http://127.0.0.1:6379",
    "http://[::1]:8080",
    "http://0.0.0.0:80",
  ])("rejects loopback endpoint %s", (url) => {
    expect(validateMcpEndpoint(url)).toBe("loopback endpoints are not allowed");
  });

  it.each(["file:///etc/passwd", "gopher://127.0.0.1:6379/_INFO", "ftp://example.com/x"])(
    "rejects non-http(s) scheme %s",
    (url) => {
      expect(validateMcpEndpoint(url)).toBe("endpoint must use http or https scheme");
    },
  );

  it("rejects a malformed URL", () => {
    expect(validateMcpEndpoint("not a url")).toBe("endpoint must be a valid URL");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateMcpEndpoint("  https://mcp.example.com  ")).toBeNull();
  });
});
