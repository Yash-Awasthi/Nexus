// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { isSafeUrl, isSafeSandboxPath } from "../src/security-utils.js";

describe("isSafeUrl", () => {
  describe("allowed protocols", () => {
    it("allows https", () => {
      expect(isSafeUrl("https://api.example.com/data")).toBe(true);
    });

    it("allows http", () => {
      expect(isSafeUrl("http://api.example.com/data")).toBe(true);
    });

    it("blocks file:// protocol", () => {
      expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    });

    it("blocks ftp:// protocol", () => {
      expect(isSafeUrl("ftp://example.com/file")).toBe(false);
    });

    it("blocks javascript: protocol", () => {
      expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    });
  });

  describe("SSRF — loopback and localhost", () => {
    it("blocks localhost", () => {
      expect(isSafeUrl("http://localhost/admin")).toBe(false);
    });

    it("blocks 127.0.0.1", () => {
      expect(isSafeUrl("http://127.0.0.1/secret")).toBe(false);
    });

    it("blocks 127.x.x.x subnets", () => {
      expect(isSafeUrl("http://127.0.0.2/")).toBe(false);
    });

    it("blocks IPv6 loopback [::1]", () => {
      expect(isSafeUrl("http://[::1]/")).toBe(false);
    });
  });

  describe("SSRF — cloud metadata services", () => {
    it("blocks AWS IMDS 169.254.169.254", () => {
      expect(isSafeUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    });

    it("blocks GCP metadata.google.internal", () => {
      expect(isSafeUrl("http://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    });

    it("blocks bare 'metadata' hostname", () => {
      expect(isSafeUrl("http://metadata/")).toBe(false);
    });

    it("blocks instance-data", () => {
      expect(isSafeUrl("http://instance-data/")).toBe(false);
    });
  });

  describe("SSRF — private IP ranges", () => {
    it("blocks 10.x.x.x", () => {
      expect(isSafeUrl("http://10.0.0.1/")).toBe(false);
    });

    it("blocks 192.168.x.x", () => {
      expect(isSafeUrl("http://192.168.1.1/")).toBe(false);
    });
  });

  describe("valid external URLs", () => {
    it("allows public API endpoints", () => {
      expect(isSafeUrl("https://api.openai.com/v1/chat/completions")).toBe(true);
    });

    it("allows URLs with query params", () => {
      expect(isSafeUrl("https://search.example.com/q?query=nexus&page=1")).toBe(true);
    });

    it("allows URLs with ports", () => {
      expect(isSafeUrl("https://example.com:8443/path")).toBe(true);
    });
  });

  describe("malformed URLs", () => {
    it("returns false for empty string", () => {
      expect(isSafeUrl("")).toBe(false);
    });

    it("returns false for non-URL strings", () => {
      expect(isSafeUrl("not a url")).toBe(false);
    });

    it("returns false for relative paths", () => {
      expect(isSafeUrl("/etc/passwd")).toBe(false);
    });
  });
});

describe("isSafeSandboxPath", () => {
  it("returns true for exact match", () => {
    expect(isSafeSandboxPath("/sandbox", "/sandbox")).toBe(true);
  });

  it("returns true for file inside sandbox", () => {
    expect(isSafeSandboxPath("/sandbox", "/sandbox/file.txt")).toBe(true);
  });

  it("returns true for deeply nested file", () => {
    expect(isSafeSandboxPath("/sandbox", "/sandbox/a/b/c/deep.ts")).toBe(true);
  });

  it("returns false for path traversal escape", () => {
    expect(isSafeSandboxPath("/sandbox", "/sandbox/../etc/passwd")).toBe(false);
  });

  it("returns false for sibling directory with shared prefix", () => {
    // /sandbox-escape starts with /sandbox but is not inside it
    expect(isSafeSandboxPath("/sandbox", "/sandbox-escape/secret")).toBe(false);
  });

  it("returns false for absolute path outside sandbox", () => {
    expect(isSafeSandboxPath("/sandbox", "/etc/shadow")).toBe(false);
  });

  it("handles trailing slash in parent gracefully", () => {
    expect(isSafeSandboxPath("/sandbox/", "/sandbox/file.txt")).toBe(true);
  });
});
