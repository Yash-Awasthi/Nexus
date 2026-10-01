// SPDX-License-Identifier: Apache-2.0
/** A caller-supplied URL is fetched through the pinned guard, and so is every redirect hop. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
const replies: Response[] = [];
vi.mock("@nexus/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/runtime")>()),
  pinnedFetch: async (url: string) => {
    calls.push(url);
    return replies.shift() ?? new Response("ok");
  },
}));

const { fetchPublic } = await import("../../src/lib/public-url.js");

beforeEach(() => {
  calls.length = 0;
  replies.length = 0;
  delete process.env.NEXUS_DESKTOP;
});

describe("fetchPublic", () => {
  it("refuses a private address before any request", async () => {
    await expect(fetchPublic("http://127.0.0.1:8080/x")).rejects.toThrow(/private|reserved/);
    expect(calls).toEqual([]);
  });

  it("follows a redirect only while each hop is public", async () => {
    replies.push(
      new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a.mp3" } }),
      new Response("audio"),
    );
    const res = await fetchPublic("https://example.com/a.mp3");
    expect(await res.text()).toBe("audio");
    expect(calls).toEqual(["https://example.com/a.mp3", "https://cdn.example.com/a.mp3"]);

    replies.push(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    await expect(fetchPublic("https://example.com/b.mp3")).rejects.toThrow(/private|reserved/);
    expect(calls.at(-1)).toBe("https://example.com/b.mp3");
  });
});
