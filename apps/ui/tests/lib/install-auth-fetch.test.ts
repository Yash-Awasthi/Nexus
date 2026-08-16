// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import { installAuthFetch } from "../../app/lib/install-auth-fetch";

const TOKEN_KEY = "nexus_token";
const TOKEN = "test-token-abc";

function authHeader(init: RequestInit | undefined): string | null {
  if (!init?.headers) return null;
  return new Headers(init.headers).get("Authorization");
}

describe("installAuthFetch", () => {
  let mockOriginal: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    mockOriginal = vi.fn().mockResolvedValue(new Response(null));
    window.fetch = mockOriginal as unknown as typeof window.fetch;
    installAuthFetch();
  });

  beforeEach(() => {
    mockOriginal.mockClear();
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
  });

  it("attaches the bearer token to a relative /api request", async () => {
    await window.fetch("/api/things");
    const [, init] = mockOriginal.mock.calls[0];
    expect(authHeader(init)).toBe(`Bearer ${TOKEN}`);
  });

  it("attaches the bearer token to an absolute same-origin /api request", async () => {
    await window.fetch(`${window.location.origin}/api/things`);
    const [, init] = mockOriginal.mock.calls[0];
    expect(authHeader(init)).toBe(`Bearer ${TOKEN}`);
  });

  it("does not attach the token, and does not touch the target, for a cross-origin URL that merely contains the api host as a substring", async () => {
    const evilUrl = `https://evil.tld/x?u=https://${window.location.host}/api/y`;
    await window.fetch(evilUrl);
    const [passedInput, init] = mockOriginal.mock.calls[0];
    expect(authHeader(init)).toBeNull();
    expect(passedInput).toBe(evilUrl);
  });

  it("does not attach the token to an unrelated cross-origin request", async () => {
    await window.fetch("https://evil.tld/steal");
    const [, init] = mockOriginal.mock.calls[0];
    expect(authHeader(init)).toBeNull();
  });

  it("does not override an Authorization header the caller already set", async () => {
    await window.fetch("/api/things", { headers: { Authorization: "Bearer caller-token" } });
    const [, init] = mockOriginal.mock.calls[0];
    expect(authHeader(init)).toBe("Bearer caller-token");
  });
});
