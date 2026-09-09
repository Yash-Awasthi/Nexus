// SPDX-License-Identifier: Apache-2.0
// Crawlee session-pool port (row 71) — Session/Pool semantics + spider wiring.
import { describe, expect, it } from "vitest";
import {
  CrawlSession,
  SessionPool,
  isBlockedStatus,
  BLOCKED_STATUS_CODES,
  createDefaultSessionFingerprint,
} from "./sessions.js";
import { Spider, type CrawledPage } from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle (crawlee Session semantics)
// ─────────────────────────────────────────────────────────────────────────────

describe("CrawlSession", () => {
  it("starts usable with defaults", () => {
    const s = new CrawlSession();
    expect(s.isUsable()).toBe(true);
    expect(s.errorScore).toBe(0);
    expect(s.usageCount).toBe(0);
    expect(s.id).toMatch(/^session_/);
  });

  it("markBad reaches maxErrorScore and self-retires as blocked", () => {
    const s = new CrawlSession({ maxErrorScore: 3 });
    s.markBad();
    s.markBad();
    expect(s.isUsable()).toBe(true);
    s.markBad();
    expect(s.isBlocked()).toBe(true);
    expect(s.retired).toBe(true); // maybeSelfRetire after reaching the cap
    expect(s.isUsable()).toBe(false);
  });

  it("markGood heals the error score by the decrement", () => {
    const s = new CrawlSession({ errorScoreDecrement: 0.5 });
    s.markBad(); // errorScore 1
    expect(s.errorScore).toBe(1);
    s.markGood(); // 1 → 0.5
    expect(s.errorScore).toBeCloseTo(0.5);
    expect(s.isUsable()).toBe(true);
    s.markGood(); // 0.5 → 0
    expect(s.errorScore).toBe(0);
  });

  it("retire is terminal and cannot be revived", () => {
    const s = new CrawlSession();
    s.retire();
    expect(s.retired).toBe(true);
    expect(s.isUsable()).toBe(false);
    s.markGood();
    expect(s.retired).toBe(true);
    expect(s.isUsable()).toBe(false);
    s.retire(); // no-op
    expect(s.retired).toBe(true);
  });

  it("expires after maxAgeSecs from createdAt", () => {
    const past = new Date(Date.now() - 60_000);
    const s = new CrawlSession({ createdAt: past, maxAgeSecs: 10 });
    expect(s.isExpired()).toBe(true);
    expect(s.isUsable()).toBe(false);
    const fresh = new CrawlSession({ createdAt: new Date(), maxAgeSecs: 3000 });
    expect(fresh.isUsable()).toBe(true);
  });

  it("self-retires once maxUsageCount is reached", () => {
    const s = new CrawlSession({ maxUsageCount: 2 });
    s.markGood();
    expect(s.isUsable()).toBe(true);
    s.markGood();
    expect(s.retired).toBe(true);
    expect(s.isUsable()).toBe(false);
  });

  it("round-trips through getState for persistence", () => {
    const s = new CrawlSession({
      id: "ident-1",
      maxUsageCount: 5,
      userData: { headers: { "x-id": "1" } },
    });
    s.markBad();
    const state = s.getState();
    expect(state.id).toBe("ident-1");
    expect(state.errorScore).toBe(1);
    const restored = new CrawlSession({
      ...state,
      createdAt: new Date(state.createdAt),
      expiresAt: new Date(state.expiresAt),
    });
    expect(restored.id).toBe("ident-1");
    expect(restored.errorScore).toBe(1);
    expect(restored.usageCount).toBe(1);
    expect(restored.isUsable()).toBe(true);
  });

  it("exposes blocked-status vocabulary", () => {
    expect(BLOCKED_STATUS_CODES).toEqual([401, 403, 429]);
    expect(isBlockedStatus(403)).toBe(true);
    expect(isBlockedStatus(404)).toBe(false);
    expect(isBlockedStatus(200)).toBe(false);
  });

  it("creates a realistic fingerprint for the host platform", () => {
    const fp = createDefaultSessionFingerprint("windows");
    expect(fp.browser).toBeTruthy();
    expect(fp.device).toBeTruthy();
    expect(fp.platform).toBe("windows");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SessionPool (crawlee pool semantics)
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionPool", () => {
  it("creates a fresh session while the pool has space (random strategy)", async () => {
    const pool = new SessionPool({ maxPoolSize: 2 });
    const a = await pool.getSession();
    const b = await pool.getSession();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).not.toBe(b!.id);
    expect(pool.usableSessionsCount()).toBe(2);
  });

  it("reuses usable sessions once the pool is full", async () => {
    const pool = new SessionPool({ maxPoolSize: 2, sessionReuseStrategy: "random" });
    await pool.getSession();
    await pool.getSession();
    // Full now — a pick must return one of the two existing sessions.
    const picked = await pool.getSession();
    expect(pool.sessions.some((s) => s.id === picked!.id)).toBe(true);
    expect(pool.usableSessionsCount()).toBe(2);
  });

  it("use-until-failure strategy reuses the first usable session", async () => {
    const pool = new SessionPool({
      maxPoolSize: 3,
      sessionReuseStrategy: "use-until-failure",
    });
    const a = await pool.getSession();
    expect(a).toBeDefined();
    const again = await pool.getSession();
    expect(again!.id).toBe(a!.id); // same session reused
    again!.markGood();
    const third = await pool.getSession();
    expect(third!.id).toBe(a!.id);
  });

  it("round-robin strategy cycles through sessions", async () => {
    const pool = new SessionPool({ maxPoolSize: 2, sessionReuseStrategy: "round-robin" });
    const a = await pool.getSession(); // created (space)
    await pool.getSession(); // created (space) — pool now full
    const c = await pool.getSession(); // round-robin index 0 → sessions[0] (a)
    const d = await pool.getSession(); // index 1 → sessions[1] (b)
    const e = await pool.getSession(); // index 2 % 2 = 0 → a again
    expect(c!.id).toBe(a!.id);
    expect(d!.id).not.toBe(a!.id);
    expect(e!.id).toBe(a!.id);
  });

  it("returns a usable session by id and undefined for unknown/retired ids", async () => {
    const pool = new SessionPool({ maxPoolSize: 2, sessionReuseStrategy: "use-until-failure" });
    const s = await pool.getSession();
    expect((await pool.getSession(s!.id))!.id).toBe(s!.id);
    expect(await pool.getSession("nope")).toBeUndefined();
    s!.retire();
    expect(await pool.getSession(s!.id)).toBeUndefined();
  });

  it("drops unusable sessions to make room and creates fresh ones", async () => {
    const pool = new SessionPool({ maxPoolSize: 1, sessionReuseStrategy: "random" });
    const first = await pool.getSession(); // pool full (size 1)
    first!.retire();
    expect(pool.usableSessionsCount()).toBe(0);
    const second = await pool.getSession(); // full + retired → drop, create
    expect(second!.id).not.toBe(first!.id);
    expect(second!.isUsable()).toBe(true);
    expect(pool.usableSessionsCount()).toBe(1);
  });

  it("rejects duplicate ids on addSession", async () => {
    const pool = new SessionPool({ maxPoolSize: 2 });
    const s = await pool.newSession({ id: "dup" });
    await expect(pool.addSession({ id: "dup" })).rejects.toThrow(/already exists/);
    expect(pool.retiredSessionsCount()).toBe(0);
    expect(pool.sessions.some((x) => x.id === s.id)).toBe(true);
  });

  it("applies the custom createSessionFunction and pool-wide session options", async () => {
    const pool = new SessionPool({
      maxPoolSize: 2,
      sessionOptions: { userData: { headers: { "x-pool": "yes" } } },
      createSessionFunction: async ({ sessionOptions }) =>
        new CrawlSession({ ...sessionOptions, userData: { headers: { "x-pool": "custom" } } }),
    });
    const s = await pool.getSession();
    expect(s!.userData.headers).toEqual({ "x-pool": "custom" });
  });

  it("restores only usable sessions from a persisted state snapshot", async () => {
    const pool = new SessionPool({ maxPoolSize: 5 });
    const good = await pool.newSession({ id: "good-1" });
    const bad = await pool.newSession({ id: "bad-1" });
    bad.markBad();
    bad.markBad();
    bad.markBad(); // self-retired as blocked
    const state = pool.getState();
    expect(state.usableSessionsCount).toBe(1);

    const fresh = new SessionPool({ maxPoolSize: 5 });
    await fresh.restore(state);
    expect(fresh.sessions.length).toBe(1);
    expect(fresh.sessions[0].id).toBe("good-1");
    expect(fresh.sessions[0].isUsable()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spider integration (session pool wired into the crawl loop)
// ─────────────────────────────────────────────────────────────────────────────

function makeSequenceFetch(statuses: number[]): {
  fetch: typeof fetch;
  calls: number;
  seenHeaders: string[];
} {
  let calls = 0;
  const seenHeaders: string[] = [];
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const status = statuses[Math.min(calls, statuses.length - 1)];
      const headers = new Headers({
        "content-type": "text/html",
        ...(init?.headers as Record<string, string>),
      });
      seenHeaders.push((init?.headers as Record<string, string>)["x-session-id"] ?? "(none)");
      calls += 1;
      void url;
      return new Response("<html><body>ok</body></html>", { status, headers });
    }) as typeof fetch,
    get calls() {
      return calls;
    },
    get seenHeaders() {
      return seenHeaders;
    },
  };
}

function makeSpiderTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    url: "https://example.com",
    maxPages: 5,
    maxDepth: 2,
    respectRobotsTxt: false,
    requestDelayMs: 0,
    followLinks: false,
    ...overrides,
  } as unknown as Parameters<Spider["crawl"]>[0];
}

describe("Spider session-pool wiring", () => {
  it("retires a session on a blocked status and retries on a fresh identity", async () => {
    const mock = makeSequenceFetch([403, 200]);
    const pool = new SessionPool({ maxPoolSize: 2, sessionReuseStrategy: "random" });
    const spider = new Spider({
      fetch: mock.fetch,
      sessionPool: pool,
      delay: async () => {},
      maxRetries: 1,
    });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeSpiderTarget(), async (p) => pages.push(p));

    expect(mock.calls).toBe(2);
    expect(pages[0].statusCode).toBe(200);
    // First identity was retired by the 403, second served the 200.
    expect(pool.sessions.length).toBe(2);
    const retired = pool.sessions.filter((s) => s.retired);
    const usable = pool.sessions.filter((s) => s.isUsable());
    expect(retired.length).toBe(1);
    expect(usable.length).toBe(1);
  });

  it("marks a successful response good (usage advances, error heals)", async () => {
    const { fetch } = makeSequenceFetch([200]);
    const pool = new SessionPool({ maxPoolSize: 1, sessionReuseStrategy: "use-until-failure" });
    const spider = new Spider({ fetch, sessionPool: pool, delay: async () => {} });
    await spider.crawl(makeSpiderTarget(), async () => {});
    expect(pool.sessions[0].usageCount).toBe(1);
    expect(pool.sessions[0].isUsable()).toBe(true);
  });

  it("marks a network error bad and still succeeds on retry", async () => {
    const { fetch } = makeSequenceFetch([200]);
    let calls = 0;
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return fetch(input as string, init);
    }) as typeof fetch;
    const pool = new SessionPool({ maxPoolSize: 1, sessionReuseStrategy: "use-until-failure" });
    const spider = new Spider({
      fetch: failingFetch,
      sessionPool: pool,
      delay: async () => {},
      maxRetries: 1,
    });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeSpiderTarget(), async (p) => pages.push(p));
    expect(pages[0].statusCode).toBe(200);
    const s = pool.sessions[0];
    expect(s.errorScore).toBeCloseTo(0.5); // 1 (markBad) − 0.5 (markGood)
    expect(s.usageCount).toBe(2);
    expect(s.isUsable()).toBe(true);
  });

  it("merges per-session userData.headers into the request", async () => {
    const { fetch, seenHeaders } = makeSequenceFetch([200]);
    const pool = new SessionPool({
      maxPoolSize: 2,
      createSessionFunction: async ({ sessionOptions }) =>
        new CrawlSession({
          ...sessionOptions,
          id: "id-abc",
          userData: { headers: { "x-session-id": "id-abc" } },
        }),
    });
    const spider = new Spider({ fetch, sessionPool: pool, delay: async () => {} });
    await spider.crawl(makeSpiderTarget(), async () => {});
    expect(seenHeaders).toContain("id-abc");
  });

  it("recovers when the pool arrives with only retired sessions (crawlee self-heal)", async () => {
    const mock = makeSequenceFetch([200]);
    const pool = new SessionPool({ maxPoolSize: 1 });
    const dead = await pool.newSession({ id: "dead" });
    dead.retire();
    const spider = new Spider({ fetch: mock.fetch, sessionPool: pool, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeSpiderTarget(), async (p) => pages.push(p));
    // Full pool with only unusable sessions: drop retired, create a fresh identity.
    expect(mock.calls).toBe(1);
    expect(pages[0].statusCode).toBe(200);
    expect(pool.usableSessionsCount()).toBe(1);
    expect(pool.sessions[0].id).not.toBe("dead");
  });

  it("leaves non-blocked non-ok statuses unmarked (neutral, crawlee semantics)", async () => {
    const { fetch } = makeSequenceFetch([404]);
    const pool = new SessionPool({ maxPoolSize: 1, sessionReuseStrategy: "use-until-failure" });
    const spider = new Spider({ fetch, sessionPool: pool, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeSpiderTarget(), async (p) => pages.push(p));
    const s = pool.sessions[0];
    expect(pages[0].statusCode).toBe(404);
    expect(s.errorScore).toBe(0);
    expect(s.usageCount).toBe(0);
    expect(s.isUsable()).toBe(true);
  });
});
