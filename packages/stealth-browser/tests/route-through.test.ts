// SPDX-License-Identifier: Apache-2.0
/** Every request a page makes is answered by the server's guard, never by the browser's own connection. */
import { describe, expect, it } from "vitest";

import { routeThrough, type RequestVia, type RouteLike } from "../src/index.js";

function fakeRoute(url: string, method = "GET", body: Buffer | null = null) {
  const seen: { fulfilled?: Parameters<RouteLike["fulfill"]>[0]; aborted?: string } = {};
  const route: RouteLike = {
    request: () => ({
      url: () => url,
      method: () => method,
      allHeaders: async () => ({
        host: "example.com",
        "accept-encoding": "gzip",
        cookie: "sid=1",
        ":authority": "example.com",
      }),
      postDataBuffer: () => body,
    }),
    fulfill: async (r) => {
      seen.fulfilled = r;
    },
    abort: async (code) => {
      seen.aborted = code ?? "failed";
    },
  };
  return { route, seen };
}

describe("routeThrough", () => {
  it("answers from requestVia with its status, headers and body, minus hop headers", async () => {
    const calls: { url: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
    const via: RequestVia = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const h = new Headers({ "content-type": "text/html", "content-encoding": "gzip" });
      h.append("set-cookie", "a=1");
      h.append("set-cookie", "b=2");
      return new Response("<p>hi</p>", { status: 200, headers: h });
    };
    const { route, seen } = fakeRoute("https://example.com/x", "POST", Buffer.from("q=1"));
    await routeThrough(route, via);
    expect(calls[0]!.url).toBe("https://example.com/x");
    expect(calls[0]!.headers).toEqual({ cookie: "sid=1" });
    expect(Buffer.from(calls[0]!.body!).toString()).toBe("q=1");
    expect(seen.fulfilled!.status).toBe(200);
    expect(seen.fulfilled!.headers).toEqual({
      "content-type": "text/html",
      "set-cookie": "a=1\nb=2",
    });
    expect(seen.fulfilled!.body.toString()).toBe("<p>hi</p>");
  });

  it("follows redirects itself, each hop through the guard", async () => {
    const asked: string[] = [];
    const via: RequestVia = async (url) => {
      asked.push(url);
      if (url.endsWith("/hop"))
        return new Response(null, { status: 302, headers: { location: "/next" } });
      if (url.endsWith("/next"))
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
      throw new Error("SSRF guard: private address");
    };
    const blocked = fakeRoute("https://example.com/hop");
    await routeThrough(blocked.route, via);
    expect(asked).toEqual([
      "https://example.com/hop",
      "https://example.com/next",
      "http://127.0.0.1/",
    ]);
    expect(blocked.seen).toEqual({ aborted: "blockedbyclient" });

    const fine: RequestVia = async (url) =>
      url.endsWith("/start")
        ? new Response(null, { status: 301, headers: { location: "https://www.example.com/" } })
        : new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } });
    const moved = fakeRoute("https://example.com/start");
    await routeThrough(moved.route, fine);
    expect(moved.seen.fulfilled!.status).toBe(200);
    expect(moved.seen.fulfilled!.body.toString()).toBe(
      '<base href="https://www.example.com/"><p>ok</p>',
    );
  });

  it("aborts when the guard refuses, and never lets other schemes through", async () => {
    const refuse: RequestVia = () => Promise.reject(new Error("SSRF guard: private address"));
    const blocked = fakeRoute("http://127.0.0.1/admin");
    await routeThrough(blocked.route, refuse);
    expect(blocked.seen).toEqual({ aborted: "blockedbyclient" });

    const file = fakeRoute("file:///etc/passwd");
    await routeThrough(file.route, async () => new Response("leak"));
    expect(file.seen).toEqual({ aborted: "blockedbyclient" });
  });
});
