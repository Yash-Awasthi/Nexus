// SPDX-License-Identifier: Apache-2.0
/**
 * The outbound-fetch guard, tested as an attack: a URL a caller wrote down must not be able to
 * reach loopback, a private range or a cloud metadata service — including after a redirect,
 * which is the hop that a naive "check the URL, then follow redirects" implementation misses.
 *
 * Two layers are checked:
 *
 *  - the request-time guard (`unsafeUrlReason`, `fetchPublic`), with an injected transport so
 *    the redirect walk is exercised without a network;
 *  - the wiring: the routes that fetch a caller-supplied URL must go through the guard, which
 *    is asserted against the source. A correct guard that one route forgets to call is the bug
 *    this file exists to catch.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const {
  unsafeUrlReason,
  fetchPublic,
  FETCH_REDIRECT_LIMIT,
} = await import("../../src/lib/public-url.ts");

const ORIGINAL_DESKTOP = process.env.NEXUS_DESKTOP;
afterEach(() => {
  if (ORIGINAL_DESKTOP === undefined) delete process.env.NEXUS_DESKTOP;
  else process.env.NEXUS_DESKTOP = ORIGINAL_DESKTOP;
});

/** A transport that answers with the given status/location and records what it was asked for. */
function transport(status: number, location?: string) {
  const asked: string[] = [];
  const send = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response("", {
      status,
      headers: location ? { location } : {},
    });
  }) as unknown as typeof fetch;
  return { send, asked };
}

describe("the request-time guard", () => {
  it("refuses a scheme that is not http(s)", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://x", "", null, 42]) {
      expect(unsafeUrlReason(url as unknown), String(url)).toMatch(/must start with http/);
    }
  });

  it("refuses loopback, private ranges, link-local and metadata addresses", () => {
    delete process.env.NEXUS_DESKTOP;
    for (const url of [
      "http://localhost:3000/x",
      "http://127.0.0.1/x",
      "http://127.1.2.3/x",
      "http://[::1]/x",
      "http://10.1.2.3/x",
      "http://172.16.0.1/x",
      "http://172.31.255.255/x",
      "http://192.168.0.1/x",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://0.0.0.0/x",
    ]) {
      expect(unsafeUrlReason(url), url).toMatch(/private or reserved/);
    }
  });

  it("allows a public address, and allows private ones only on the desktop build", () => {
    delete process.env.NEXUS_DESKTOP;
    expect(unsafeUrlReason("https://example.com/page")).toBeNull();
    expect(unsafeUrlReason("  https://example.com/page  ")).toBeNull();
    // The desktop app fetches on the user's own machine, where localhost is theirs to reach.
    process.env.NEXUS_DESKTOP = "1";
    expect(unsafeUrlReason("http://localhost:11434/v1/models")).toBeNull();
  });
});

describe("the redirect walk", () => {
  it("refuses a redirect to a metadata address instead of following it", async () => {
    delete process.env.NEXUS_DESKTOP;
    const { send, asked } = transport(302, "http://169.254.169.254/latest/meta-data/");
    await expect(fetchPublic("https://example.com/redirect", {}, send)).rejects.toThrow(
      /private or reserved/,
    );
    // The first hop was fetched; the second never was. That is the whole difference between a
    // guard and a comment.
    expect(asked).toEqual(["https://example.com/redirect"]);
  });

  it("refuses a relative redirect that resolves onto loopback", async () => {
    const { send, asked } = transport(301, "http://127.0.0.1:6379/");
    await expect(fetchPublic("https://example.com/x", {}, send)).rejects.toThrow(/private/);
    expect(asked).toHaveLength(1);
  });

  it("follows a public redirect and stops at the 200", async () => {
    const asked: string[] = [];
    const send = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return String(input).endsWith("/final")
        ? new Response("ok", { status: 200 })
        : new Response("", { status: 302, headers: { location: "https://example.org/final" } });
    }) as unknown as typeof fetch;
    const res = await fetchPublic("https://example.com/start", {}, send);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(asked).toEqual(["https://example.com/start", "https://example.org/final"]);
  });

  it("gives up after the documented number of hops instead of looping", async () => {
    // Every hop is public, so the only thing that stops this is the counter.
    const { send, asked } = transport(302, "https://example.com/again");
    await expect(fetchPublic("https://example.com/start", {}, send)).rejects.toThrow(
      /Too many redirects/,
    );
    expect(asked).toHaveLength(FETCH_REDIRECT_LIMIT + 1);
  });
});

describe("the wiring", () => {
  const src = (relative: string): string =>
    fs.readFileSync(path.resolve(__dirname, "../../src", relative), "utf8");

  it("sends every route that fetches a caller-supplied URL through the guard", () => {
    // Each of these takes a URL from a request body and fetches it.
    for (const route of [
      "routes/kb.ts",
      "routes/context.ts",
      "routes/mcp-openapi.ts",
      "routes/scraping-mcp.ts",
      "routes/browser-agent.ts",
      "routes/reactions.ts",
      "routes/provider-keys.ts",
    ]) {
      const source = src(route);
      expect(
        source.includes("fetchPublic") || source.includes("unsafeUrlReason"),
        `${route} fetches a caller-supplied URL without the guard`,
      ).toBe(true);
    }
  });

  it("does not hand-roll a redirect-following fetch anywhere in the API", () => {
    // A raw `fetch(url, { redirect: "follow" })` on a caller URL is the exact bug `fetchPublic`
    // exists to prevent; none should exist.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (/redirect:\s*["']follow["']/.test(text)) offenders.push(full);
        }
      }
    };
    walk(path.resolve(__dirname, "../../src"));
    expect(offenders).toEqual([]);
  });
});
