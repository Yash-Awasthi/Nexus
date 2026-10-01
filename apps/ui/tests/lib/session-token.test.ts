// SPDX-License-Identifier: Apache-2.0
/**
 * Stage E2 — where the access token lives.
 *
 * The access token lives in memory only, in a browser tab and under a host
 * alike; a token an earlier version stored is moved into memory once and
 * deleted. The patched fetch reads that one place.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createAuthFetch } from "../../app/lib/install-auth-fetch";
import { adoptStoredToken, getSessionToken, setSessionToken } from "../../app/lib/session-token";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  setSessionToken(null);
  (globalThis as { window?: unknown }).window = {
    location: { href: "https://app.test/", host: "app.test" },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

describe("session token", () => {
  it("never reads browser storage on its own", () => {
    store.set("nexus_token", "from-storage");

    expect(getSessionToken()).toBeNull();
  });

  it("moves a token an earlier version stored into memory and deletes it", () => {
    store.set("nexus_token", "from-storage");
    adoptStoredToken();

    expect(getSessionToken()).toBe("from-storage");
    expect(store.size).toBe(0);
  });

  it("keeps a token already in memory over a stored one", () => {
    setSessionToken("from-host");
    store.set("nexus_token", "from-storage");
    adoptStoredToken();

    expect(getSessionToken()).toBe("from-host");
  });

  it("writes nothing to browser storage", () => {
    setSessionToken("from-host");

    expect(store.size).toBe(0);
  });
});

describe("patched fetch", () => {
  it("attaches the host's token without it ever being stored", async () => {
    setSessionToken("from-host");
    const original = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const patched = createAuthFetch(original as unknown as typeof fetch, async () => false);

    await patched("/api/threads");

    const headers = new Headers((original.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer from-host");
    expect(store.size).toBe(0);
  });
});

describe("session bootstrap order", () => {
  it("asks a host that owns the session before reading browser storage", () => {
    const source = readFileSync(path.join(__dirname, "../../app/context/AuthContext.tsx"), "utf8");
    const bootstrap = source.slice(source.indexOf("export function AuthProvider"));

    const asksHost = bootstrap.indexOf('hostCan("localAccount")');
    const readsStorage = bootstrap.indexOf("localStorage.getItem(STORAGE_KEY)");

    // A profile blob left by a previous run matches the storage branch, so
    // reading storage first leaves the keychain session unread and every API
    // call unauthenticated while the window looks signed in.
    expect(asksHost).toBeGreaterThan(-1);
    expect(asksHost).toBeLessThan(readsStorage);
  });
});
