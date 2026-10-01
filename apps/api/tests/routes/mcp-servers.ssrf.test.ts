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

  const HOST_BLOCKED = "endpoint host is not allowed (loopback, private, or reserved address)";

  it.each([
    "http://localhost/admin",
    "http://127.0.0.1:6379",
    "http://[::1]:8080",
    "http://0.0.0.0:80",
  ])("rejects loopback endpoint %s", (url) => {
    expect(validateMcpEndpoint(url)).toBe(HOST_BLOCKED);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/", // AWS/GCP IMDS link-local
    "http://metadata.google.internal/computeMetadata/v1/", // GCP metadata host
    "http://10.0.0.5:8080", // RFC1918 10/8
    "http://172.16.0.1/x", // RFC1918 172.16/12
    "http://192.168.1.1/x", // RFC1918 192.168/16
    "http://100.64.0.1/x", // CGNAT 100.64/10
  ])("rejects private / metadata endpoint %s", (url) => {
    expect(validateMcpEndpoint(url)).toBe(HOST_BLOCKED);
  });

  it.each([
    "http://2130706433/x", // decimal 127.0.0.1
    "http://0x7f000001/x", // hex 127.0.0.1
    "http://0177.0.0.1/x", // octal 127.0.0.1
    "http://[::ffff:127.0.0.1]/x", // IPv4-mapped IPv6 loopback
  ])("rejects smuggled-encoding loopback %s", (url) => {
    expect(validateMcpEndpoint(url)).toBe(HOST_BLOCKED);
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
