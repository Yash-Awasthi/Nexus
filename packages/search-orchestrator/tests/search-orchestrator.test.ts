// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { searchExa, searchBrave, searchSerper, type FetchLike } from "../src/index.js";
// ─────────────────────────────────────────────────────────────────────────────
// §1.3 web-search providers — Exa / Brave / Serper
// ─────────────────────────────────────────────────────────────────────────────

/** Injectable fetch mock returning one JSON payload (or throwing). */
function fetchJson(body: unknown, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  })) as unknown as FetchLike;
}

const EXA_BODY = {
  results: [
    {
      id: "exa-1",
      url: "https://example.com/a",
      title: "Result A",
      text: "Full text of A",
      score: 0.97,
      publishedDate: "2026-08-01T00:00:00.000Z",
    },
    { id: "exa-2", url: "https://example.com/b", title: "Result B", score: 0.81 },
  ],
};

describe("searchExa", () => {
  it("throws without a key (no env, no apiKey)", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    await expect(searchExa("q", { fetchFn: fetchJson(EXA_BODY) })).rejects.toThrow(/EXA_API_KEY/);
    vi.unstubAllEnvs();
  });

  it("POSTs the Exa wire shape: x-api-key header, type auto, text inline", async () => {
    const fetchFn = fetchJson(EXA_BODY);
    const results = await searchExa("hello", { apiKey: "exa-key", fetchFn });
    const f = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("exa-key");
    const body = JSON.parse(init.body) as {
      query: string;
      numResults: number;
      type: string;
      text: boolean;
    };
    expect(body).toMatchObject({ query: "hello", numResults: 10, type: "auto", text: true });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "exa-1",
      content: "Full text of A",
      source: "exa",
      score: 0.97,
      timestamp: "2026-08-01T00:00:00.000Z",
    });
    expect(results[0]!.metadata?.url).toBe("https://example.com/a");
    // Second result has no text → falls back to title
    expect(results[1]!.content).toBe("Result B");
  });

  it("respects type + includeText:false options", async () => {
    const fetchFn = fetchJson(EXA_BODY);
    await searchExa("q", { apiKey: "k", type: "neural", includeText: false, fetchFn });
    const body = JSON.parse(
      (
        (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
      )[1].body,
    ) as { type: string; text?: boolean };
    expect(body.type).toBe("neural");
    expect(body.text).toBeUndefined();
  });

  it("maps HTTP errors to thrown messages", async () => {
    await expect(
      searchExa("q", { apiKey: "k", fetchFn: fetchJson({ detail: "nope" }, 401) }),
    ).rejects.toThrow(/Exa 401/);
  });
});

const BRAVE_BODY = {
  web: {
    results: [
      {
        title: "Brave One",
        url: "https://brave.example/1",
        description: "First brave result",
        age: "2 days ago",
      },
      { title: "Brave Two", url: "https://brave.example/2", description: "Second" },
    ],
  },
};

describe("searchBrave", () => {
  it("throws without a key", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    await expect(searchBrave("q", { fetchFn: fetchJson(BRAVE_BODY) })).rejects.toThrow(
      /BRAVE_API_KEY/,
    );
    vi.unstubAllEnvs();
  });

  it("GETs with X-Subscription-Token auth and count/country/freshness params", async () => {
    const fetchFn = fetchJson(BRAVE_BODY);
    const results = await searchBrave("hello", {
      apiKey: "brave-key",
      freshness: "pw",
      country: "de",
      fetchFn,
    });
    const f = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search?");
    expect(url).toContain("q=hello");
    expect(url).toContain("count=10");
    expect(url).toContain("country=de");
    expect(url).toContain("freshness=pw");
    expect(init.headers["X-Subscription-Token"]).toBe("brave-key");
    expect(results[0]).toMatchObject({
      id: "brave-0",
      content: "First brave result",
      source: "brave",
      score: 1,
      timestamp: "2 days ago",
    });
    expect(results[0]!.metadata?.url).toBe("https://brave.example/1");
  });

  it("handles an empty web block and HTTP errors", async () => {
    expect(await searchBrave("q", { apiKey: "k", fetchFn: fetchJson({}) })).toHaveLength(0);
    await expect(searchBrave("q", { apiKey: "k", fetchFn: fetchJson({}, 429) })).rejects.toThrow(
      /Brave 429/,
    );
  });
});

const SERPER_BODY = {
  organic: [
    {
      title: "Serper One",
      link: "https://serper.example/1",
      snippet: "Top hit",
      position: 1,
      date: "3 days ago",
    },
    { title: "Serper Two", link: "https://serper.example/2", snippet: "Second hit", position: 2 },
  ],
};

describe("searchSerper", () => {
  it("throws without a key", async () => {
    vi.stubEnv("SERPER_API_KEY", "");
    await expect(searchSerper("q", { fetchFn: fetchJson(SERPER_BODY) })).rejects.toThrow(
      /SERPER_API_KEY/,
    );
    vi.unstubAllEnvs();
  });

  it("POSTs {q,num,gl,hl} with X-API-KEY auth", async () => {
    const fetchFn = fetchJson(SERPER_BODY);
    const results = await searchSerper("hello", { apiKey: "sp-key", gl: "de", hl: "de", fetchFn });
    const f = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://google.serper.dev/search");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-KEY"]).toBe("sp-key");
    const body = JSON.parse(init.body) as { q: string; num: number; gl: string; hl: string };
    expect(body).toEqual({ q: "hello", num: 10, gl: "de", hl: "de" });
    expect(results[0]).toMatchObject({
      id: "serper-0",
      content: "Top hit",
      source: "serper",
      score: 1,
      timestamp: "3 days ago",
    });
    expect(results[0]!.metadata?.url).toBe("https://serper.example/1");
  });

  it("handles an empty organic list and HTTP errors", async () => {
    expect(await searchSerper("q", { apiKey: "k", fetchFn: fetchJson({}) })).toHaveLength(0);
    await expect(searchSerper("q", { apiKey: "k", fetchFn: fetchJson({}, 500) })).rejects.toThrow(
      /Serper 500/,
    );
  });
});
