// SPDX-License-Identifier: Apache-2.0
/**
 * Under a host that owns the session, the token arrives over IPC after the
 * page's first effects run. API calls made in that gap must wait for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapSession } from "../../app/context/AuthContext";
import { createAuthFetch } from "../../app/lib/install-auth-fetch";
import { setSessionToken } from "../../app/lib/session-token";

afterEach(() => {
  setSessionToken(null);
  delete (window as { nexusHost?: unknown }).nexusHost;
});

describe("desktop session bootstrap", () => {
  it("holds the first page requests until the host hands over its token", async () => {
    (window as { nexusHost?: unknown }).nexusHost = {
      name: "test-host",
      capabilities: ["localAccount"],
      invoke: (method: string) =>
        method === "getSession"
          ? new Promise((resolve) =>
              setTimeout(() => resolve({ user: { id: "u1" }, accessToken: "from-keychain" }), 20),
            )
          : Promise.resolve(null),
    };
    const original = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const patched = createAuthFetch(original as unknown as typeof fetch, async () => false);

    bootstrapSession();
    await patched("/api/threads");

    const headers = new Headers((original.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("Authorization")).toBe("Bearer from-keychain");
  });
});
