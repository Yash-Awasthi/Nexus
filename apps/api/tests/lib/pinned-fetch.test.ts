// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the DNS-rebinding-safe pinned fetch.
 *
 * Hermetic: no real DNS or TCP. `createPinnedFetch` takes an injectable lookup,
 * so we drive it with `makeSafeLookup(fakeResolver)` where the resolver returns a
 * PRIVATE address — the guard must reject before any socket connects, which is
 * exactly the rebinding case a static URL check misses. Scheme rejection is a
 * plain pre-connect guard.
 */
import { createPinnedFetch, makeSafeLookup, type AllAddressResolver } from "@nexus/runtime";
import { describe, it, expect } from "vitest";

/** A DNS resolver stub that always returns `address` for any hostname. */
function resolverReturning(address: string, family = 4): AllAddressResolver {
  return (_hostname, _options, callback) => {
    callback(null, [{ address, family }]);
  };
}

describe("createPinnedFetch — DNS-rebinding guard", () => {
  it.each([
    ["10.0.0.5", "RFC1918"],
    ["169.254.169.254", "cloud IMDS link-local"],
    ["127.0.0.1", "loopback"],
  ])("blocks a hostname that resolves to a private address (%s, %s)", async (addr) => {
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning(addr)));
    await expect(fetchFn("http://rebind.evil/tools")).rejects.toThrow(
      /SSRF guard|private address/i,
    );
  });

  it("lets a public-resolving lookup past the guard (fails later at connect, not at lookup)", async () => {
    // Resolver returns a documentation-range public IP. The guard must NOT block
    // it; the request then fails to connect — a DIFFERENT error than the SSRF one.
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("203.0.113.9")));
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 50); // don't hang on the unroutable IP
    try {
      await fetchFn("http://public.test/tools", { signal: ac.signal });
      throw new Error("expected the connect to fail");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/SSRF guard|private address/i);
    } finally {
      clearTimeout(t);
    }
  });

  it.each([
    "http://127.0.0.1:9/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://[::1]:9/",
  ])("blocks a private IP literal, which never reaches the lookup (%s)", async (url) => {
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("203.0.113.9")));
    await expect(fetchFn(url)).rejects.toThrow(/SSRF guard/);
  });

  it("rejects a non-http(s) scheme before connecting", async () => {
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("203.0.113.9")));
    await expect(fetchFn("file:///etc/passwd")).rejects.toThrow(/unsupported scheme/i);
  });

  it("rejects an already-aborted signal", async () => {
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("203.0.113.9")));
    await expect(fetchFn("http://public.test/x", { signal: AbortSignal.abort() })).rejects.toThrow(
      /abort/i,
    );
  });
});

describe("createPinnedFetch — responses", () => {
  it("keeps response headers and byte bodies, and returns redirects unfollowed", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/hop") {
        res.writeHead(302, { location: "http://elsewhere.test/" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("set-cookie", ["a=1", "b=2"]);
        res.setHeader("content-type", "application/octet-stream");
        res.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // A lookup that allows loopback stands in for a public address here.
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("127.0.0.1")));
    const open = createPinnedFetch(((host: string, opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (
        e: null,
        a: unknown,
        f?: number,
      ) => void;
      const all = typeof opts === "object" && (opts as { all?: boolean }).all;
      if (all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    }) as never);
    try {
      await expect(fetchFn(`http://loop.test:${port}/`)).rejects.toThrow(/SSRF guard|private/i);
      const bytes = new Uint8Array([0, 255, 7]);
      const res = await open(`http://loop.test:${port}/`, { method: "POST", body: bytes });
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      const hop = await open(`http://loop.test:${port}/hop`);
      expect(hop.status).toBe(302);
      expect(hop.headers.get("location")).toBe("http://elsewhere.test/");
    } finally {
      server.close();
    }
  });

  it("hands the body over chunk by chunk, before the server finishes", async () => {
    const http = await import("node:http");
    let finish = (): void => {};
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("one");
      finish = () => res.end("two");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const open = createPinnedFetch(((_host: string, opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: null, a: unknown) => void;
      done(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as never);
    try {
      const res = await open(`http://loop.test:${port}/`);
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("one");
      finish();
      let rest = "";
      for (let r = await reader.read(); !r.done; r = await reader.read())
        rest += new TextDecoder().decode(r.value);
      expect(rest).toBe("two");
    } finally {
      server.close();
    }
  });

  it("decodes a compressed body, as fetch does", async () => {
    const http = await import("node:http");
    const zlib = await import("node:zlib");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(zlib.gzipSync("<title>hello</title>"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const open = createPinnedFetch(((_host: string, opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: null, a: unknown) => void;
      done(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as never);
    try {
      const res = await open(`http://loop.test:${port}/`);
      expect(await res.text()).toBe("<title>hello</title>");
      expect(res.headers.get("content-encoding")).toBeNull();
    } finally {
      server.close();
    }
  });
});
