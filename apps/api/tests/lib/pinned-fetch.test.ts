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
import { makeSafeLookup, type AllAddressResolver } from "@nexus/runtime";
import { describe, it, expect } from "vitest";

import { createPinnedFetch } from "../../src/lib/pinned-fetch.js";

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
    await expect(fetchFn("http://rebind.evil/tools")).rejects.toThrow(/SSRF guard|private address/i);
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

  it("rejects a non-http(s) scheme before connecting", async () => {
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("203.0.113.9")));
    await expect(fetchFn("file:///etc/passwd")).rejects.toThrow(/unsupported scheme/i);
  });

  it("rejects an already-aborted signal", async () => {
    const fetchFn = createPinnedFetch(makeSafeLookup(resolverReturning("203.0.113.9")));
    await expect(
      fetchFn("http://public.test/x", { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/abort/i);
  });
});
