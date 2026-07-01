// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  assertSafeUrl,
  isPrivateAddress,
  isSafeSandboxPath,
  isSafeUrl,
  makeSafeLookup,
  type AllAddressResolver,
  type ResolvedAddress,
} from "../src/security-utils.js";

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

    it("blocks 172.16/12 (the gap the old check missed)", () => {
      expect(isSafeUrl("http://172.16.0.1/")).toBe(false);
      expect(isSafeUrl("http://172.31.255.255/")).toBe(false);
    });

    it("does NOT block 172.32.x.x (just outside the private range)", () => {
      expect(isSafeUrl("http://172.32.0.1/")).toBe(true);
    });

    it("blocks 100.64/10 CGNAT", () => {
      expect(isSafeUrl("http://100.64.0.1/")).toBe(false);
    });

    it("blocks 0.0.0.0", () => {
      expect(isSafeUrl("http://0.0.0.0/")).toBe(false);
    });

    it("blocks link-local 169.254.x beyond the IMDS address", () => {
      expect(isSafeUrl("http://169.254.1.1/")).toBe(false);
    });
  });

  describe("SSRF — smuggled IPv4 encodings (all map to 127.0.0.1)", () => {
    it("blocks decimal 2130706433", () => {
      expect(isSafeUrl("http://2130706433/")).toBe(false);
    });

    it("blocks hex 0x7f000001", () => {
      expect(isSafeUrl("http://0x7f000001/")).toBe(false);
    });

    it("blocks dotted-hex 0x7f.0.0.1", () => {
      expect(isSafeUrl("http://0x7f.0.0.1/")).toBe(false);
    });

    it("blocks octal 0177.0.0.1", () => {
      expect(isSafeUrl("http://0177.0.0.1/")).toBe(false);
    });

    it("blocks short form 127.1", () => {
      expect(isSafeUrl("http://127.1/")).toBe(false);
    });
  });

  describe("SSRF — IPv6", () => {
    it("blocks ULA fc00::/7", () => {
      expect(isSafeUrl("http://[fd00::1]/")).toBe(false);
    });

    it("blocks link-local fe80::/10", () => {
      expect(isSafeUrl("http://[fe80::1]/")).toBe(false);
    });

    it("blocks IPv4-mapped to a private address", () => {
      expect(isSafeUrl("http://[::ffff:10.0.0.1]/")).toBe(false);
    });

    it("blocks unspecified ::", () => {
      expect(isSafeUrl("http://[::]/")).toBe(false);
    });

    it("allows a public IPv6 literal", () => {
      expect(isSafeUrl("http://[2606:4700:4700::1111]/")).toBe(true);
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

  describe("assertSafeUrl", () => {
    it("does not throw on a safe URL", () => {
      expect(() => assertSafeUrl("https://api.openai.com/v1")).not.toThrow();
    });
    it("throws on an unsafe URL", () => {
      expect(() => assertSafeUrl("http://169.254.169.254/")).toThrow(/SSRF/);
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

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local, CGNAT ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.9.9", "169.254.169.254", "100.64.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("flags IPv6 loopback/ULA/link-local", () => {
    for (const ip of ["::1", "fc00::1", "fd12::9", "fe80::1", "fe80::1%eth0"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("allows real public addresses", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false); // example.com
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("treats a non-IP string as unsafe", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("makeSafeLookup (resolve-then-pin)", () => {
  // Build a fake dns.lookup(all:true) resolver returning canned addresses.
  const resolverOf =
    (addrs: ResolvedAddress[], err?: NodeJS.ErrnoException): AllAddressResolver =>
    (_host, _opts, cb) =>
      cb(err ?? null, addrs);

  it("pins the resolved public address (single-address callback form)", () =>
    new Promise<void>((done, fail) => {
      const lookup = makeSafeLookup(resolverOf([{ address: "93.184.216.34", family: 4 }]));
      lookup("example.com", {}, (err, address, family) => {
        try {
          expect(err).toBeNull();
          expect(address).toBe("93.184.216.34");
          expect(family).toBe(4);
          done();
        } catch (e) {
          fail(e);
        }
      });
    }));

  it("returns all addresses when { all: true } is requested", () =>
    new Promise<void>((done, fail) => {
      const addrs: ResolvedAddress[] = [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ];
      makeSafeLookup(resolverOf(addrs))("example.com", { all: true }, (err, out) => {
        try {
          expect(err).toBeNull();
          expect(out).toEqual(addrs);
          done();
        } catch (e) {
          fail(e);
        }
      });
    }));

  it("rejects when ANY resolved address is private (rebinding attempt)", () =>
    new Promise<void>((done, fail) => {
      const addrs: ResolvedAddress[] = [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 }, // smuggled IMDS
      ];
      makeSafeLookup(resolverOf(addrs))("evil.example", {}, (err) => {
        try {
          expect(err).toBeTruthy();
          expect(String(err?.message)).toMatch(/private address 169\.254\.169\.254/);
          done();
        } catch (e) {
          fail(e);
        }
      });
    }));

  it("propagates resolver errors and empty-resolution failures", () =>
    new Promise<void>((done, fail) => {
      makeSafeLookup(resolverOf([]))("nx.example", {}, (err) => {
        try {
          expect(String(err?.message)).toMatch(/did not resolve/);
          done();
        } catch (e) {
          fail(e);
        }
      });
    }));
});
