// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  RoundRobinRotator,
  RandomRotator,
  LeastUsedRotator,
  StickyRotator,
  ProxyError,
  parseProxyUrl,
  parseProxyList,
  type IProxyRotator,
  type Proxy,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let _time = 1_000_000;
function makeNow() { _time = 1_000_000; return () => _time; }
function advanceTime(ms: number) { _time += ms; }

function p(host: string, port = 8080): Proxy {
  return { url: `http://${host}:${port}`, protocol: "http", host, port };
}

const P1 = p("1.1.1.1");
const P2 = p("2.2.2.2");
const P3 = p("3.3.3.3");

// ── RoundRobinRotator ─────────────────────────────────────────────────────────

describe("RoundRobinRotator", () => {
  let rot: RoundRobinRotator;
  let now: () => number;

  beforeEach(() => { now = makeNow(); rot = new RoundRobinRotator({ now }); });

  it("returns undefined when empty", () => expect(rot.next()).toBeUndefined());

  it("cycles through proxies in order", () => {
    rot.add([P1, P2, P3]);
    expect(rot.next()?.host).toBe("1.1.1.1");
    expect(rot.next()?.host).toBe("2.2.2.2");
    expect(rot.next()?.host).toBe("3.3.3.3");
    expect(rot.next()?.host).toBe("1.1.1.1"); // wraps
  });

  it("skips banned proxies", () => {
    rot.add([P1, P2]);
    rot.markBanned(P1);
    expect(rot.next()?.host).toBe("2.2.2.2");
    expect(rot.next()?.host).toBe("2.2.2.2");
  });

  it("returns undefined when all banned", () => {
    rot.add([P1, P2]);
    rot.markBanned(P1);
    rot.markBanned(P2);
    expect(rot.next()).toBeUndefined();
  });

  it("auto-recovers banned proxy after banTtlMs", () => {
    rot = new RoundRobinRotator({ now, banTtlMs: 5000 });
    rot.add([P1, P2]);
    rot.markBanned(P1);
    advanceTime(6000);
    const hosts = new Set([rot.next()?.host, rot.next()?.host]);
    expect(hosts.has("1.1.1.1")).toBe(true); // recovered
  });

  it("ignores duplicate proxy URLs", () => {
    rot.add([P1, P1, P1]);
    expect(rot.size()).toBe(1);
  });

  it("remove deletes a proxy", () => {
    rot.add([P1, P2]);
    rot.remove(P1.url);
    expect(rot.size()).toBe(1);
    expect(rot.next()?.host).toBe("2.2.2.2");
  });

  it("remove returns false for unknown URL", () => {
    expect(rot.remove("http://ghost:9999")).toBe(false);
  });

  it("markSuccess increments useCount and clears consecutiveFails", () => {
    rot.add(P1);
    rot.markFail(P1);
    rot.markSuccess(P1, 200);
    const h = rot.health()[0]!;
    expect(h.useCount).toBe(1);
    expect(h.consecutiveFails).toBe(0);
    expect(h.avgLatencyMs).toBe(200);
  });

  it("EMA latency update: prev * 0.8 + new * 0.2", () => {
    rot.add(P1);
    rot.markSuccess(P1, 100);
    rot.markSuccess(P1, 200);
    const h = rot.health()[0]!;
    expect(h.avgLatencyMs).toBeCloseTo(100 * 0.8 + 200 * 0.2);
  });

  it("markFail increments consecutiveFails and totalFails", () => {
    rot.add(P1);
    rot.markFail(P1);
    rot.markFail(P1);
    const h = rot.health()[0]!;
    expect(h.consecutiveFails).toBe(2);
    expect(h.totalFails).toBe(2);
  });

  it("auto-bans after maxConsecutiveFails", () => {
    rot = new RoundRobinRotator({ now, maxConsecutiveFails: 2 });
    rot.add([P1, P2]);
    rot.markFail(P1);
    rot.markFail(P1); // hits limit
    expect(rot.health().find(h => h.proxy.url === P1.url)?.banned).toBe(true);
    expect(rot.next()?.host).toBe("2.2.2.2"); // P1 skipped
  });

  it("markSuccess clears banned flag", () => {
    rot.add(P1);
    rot.markBanned(P1);
    expect(rot.activeSize()).toBe(0);
    rot.markSuccess(P1);
    expect(rot.health()[0]?.banned).toBe(false);
  });

  it("health returns all proxies including banned", () => {
    rot.add([P1, P2]);
    rot.markBanned(P1);
    expect(rot.health()).toHaveLength(2);
  });

  it("activeSize excludes banned", () => {
    rot.add([P1, P2, P3]);
    rot.markBanned(P1);
    expect(rot.activeSize()).toBe(2);
  });

  it("implements IProxyRotator interface", () => {
    const r: IProxyRotator = rot;
    expect(typeof r.next).toBe("function");
    expect(typeof r.add).toBe("function");
    expect(typeof r.markSuccess).toBe("function");
    expect(typeof r.markFail).toBe("function");
    expect(typeof r.markBanned).toBe("function");
    expect(typeof r.health).toBe("function");
  });
});

// ── RandomRotator ─────────────────────────────────────────────────────────────

describe("RandomRotator", () => {
  it("returns undefined when empty", () => {
    expect(new RandomRotator().next()).toBeUndefined();
  });

  it("always returns a proxy from the active pool", () => {
    const rot = new RandomRotator();
    rot.add([P1, P2, P3]);
    for (let i = 0; i < 20; i++) {
      const proxy = rot.next();
      expect(proxy).toBeDefined();
      expect(["1.1.1.1", "2.2.2.2", "3.3.3.3"]).toContain(proxy!.host);
    }
  });

  it("skips banned proxies", () => {
    const rot = new RandomRotator();
    rot.add([P1, P2]);
    rot.markBanned(P1);
    for (let i = 0; i < 10; i++) {
      expect(rot.next()?.host).toBe("2.2.2.2");
    }
  });

  it("injectable rand function for determinism", () => {
    let calls = 0;
    const rand = () => { const v = [0, 0.5, 0.9][calls++ % 3]!; return v; };
    const rot = new RandomRotator({ rand });
    rot.add([P1, P2, P3]);
    expect(rot.next()?.host).toBe("1.1.1.1"); // floor(0 * 3) = 0
    expect(rot.next()?.host).toBe("2.2.2.2"); // floor(0.5 * 3) = 1
    expect(rot.next()?.host).toBe("3.3.3.3"); // floor(0.9 * 3) = 2
  });
});

// ── LeastUsedRotator ──────────────────────────────────────────────────────────

describe("LeastUsedRotator", () => {
  let rot: LeastUsedRotator;

  beforeEach(() => { rot = new LeastUsedRotator(); });

  it("returns undefined when empty", () => expect(rot.next()).toBeUndefined());

  it("picks proxy with lowest useCount", () => {
    rot.add([P1, P2, P3]);
    rot.markSuccess(P1);
    rot.markSuccess(P1);
    rot.markSuccess(P2);
    // P3 has 0 uses — should be picked
    expect(rot.next()?.host).toBe("3.3.3.3");
  });

  it("distributes load evenly when all have same count", () => {
    rot.add([P1, P2]);
    // All have 0 uses — picks first
    const first = rot.next();
    rot.markSuccess(first!);
    // Now P1 has 1 use, P2 has 0 — picks P2
    expect(rot.next()?.host).toBe("2.2.2.2");
  });

  it("skips banned proxies", () => {
    rot.add([P1, P2]);
    rot.markBanned(P2); // P2 has 0 uses but is banned
    expect(rot.next()?.host).toBe("1.1.1.1");
  });
});

// ── StickyRotator ─────────────────────────────────────────────────────────────

describe("StickyRotator", () => {
  let rot: StickyRotator;
  let now: () => number;

  beforeEach(() => { now = makeNow(); rot = new StickyRotator({ now }); });

  it("returns undefined when empty", () => expect(rot.next()).toBeUndefined());

  it("assigns stable proxy for same session key", () => {
    rot.add([P1, P2, P3]);
    const first = rot.next("session-A");
    expect(rot.next("session-A")?.host).toBe(first?.host);
    expect(rot.next("session-A")?.host).toBe(first?.host);
  });

  it("different sessions can get different proxies", () => {
    rot.add([P1, P2]);
    const a = rot.next("session-A");
    const b = rot.next("session-B");
    expect(a?.host).not.toBe(b?.host);
  });

  it("re-assigns when sticky proxy is banned", () => {
    rot.add([P1, P2]);
    const assigned = rot.next("session-A");
    rot.markBanned(assigned!);
    const reassigned = rot.next("session-A");
    expect(reassigned).toBeDefined();
    expect(reassigned?.host).not.toBe(assigned?.host);
  });

  it("no session key falls back to round-robin", () => {
    rot.add([P1, P2]);
    expect(rot.next()).toBeDefined();
    expect(rot.next()).toBeDefined();
  });

  it("sessionCount tracks active sticky assignments", () => {
    rot.add([P1, P2, P3]);
    rot.next("session-A");
    rot.next("session-B");
    expect(rot.sessionCount()).toBe(2);
  });

  it("clearSessions removes all assignments", () => {
    rot.add([P1, P2]);
    rot.next("session-A");
    rot.next("session-B");
    rot.clearSessions();
    expect(rot.sessionCount()).toBe(0);
  });
});

// ── parseProxyUrl ─────────────────────────────────────────────────────────────

describe("parseProxyUrl", () => {
  it("parses http proxy", () => {
    const p = parseProxyUrl("http://1.2.3.4:8080");
    expect(p.protocol).toBe("http");
    expect(p.host).toBe("1.2.3.4");
    expect(p.port).toBe(8080);
    expect(p.auth).toBeUndefined();
  });

  it("parses authenticated proxy", () => {
    const p = parseProxyUrl("http://user:pass@1.2.3.4:8080");
    expect(p.auth?.username).toBe("user");
    expect(p.auth?.password).toBe("pass");
  });

  it("parses socks5 proxy", () => {
    const p = parseProxyUrl("socks5://proxy.example.com:1080");
    expect(p.protocol).toBe("socks5");
    expect(p.port).toBe(1080);
  });

  it("URL-decodes credentials", () => {
    const p = parseProxyUrl("http://user%40name:p%40ss@host:8080");
    expect(p.auth?.username).toBe("user@name");
    expect(p.auth?.password).toBe("p@ss");
  });

  it("throws ProxyError for invalid URL", () => {
    expect(() => parseProxyUrl("not-a-url")).toThrow(ProxyError);
  });
});

// ── parseProxyList ────────────────────────────────────────────────────────────

describe("parseProxyList", () => {
  it("parses newline-separated list", () => {
    const list = parseProxyList("http://1.1.1.1:80\nhttp://2.2.2.2:80");
    expect(list).toHaveLength(2);
  });

  it("parses comma-separated list", () => {
    const list = parseProxyList("http://1.1.1.1:80,http://2.2.2.2:80");
    expect(list).toHaveLength(2);
  });

  it("ignores blank lines and whitespace", () => {
    const list = parseProxyList("  http://1.1.1.1:80  \n\n  http://2.2.2.2:80  \n  ");
    expect(list).toHaveLength(2);
  });

  it("returns empty array for empty string", () => {
    expect(parseProxyList("")).toHaveLength(0);
  });
});

// ── ProxyError ────────────────────────────────────────────────────────────────

describe("ProxyError", () => {
  it("has correct name, code, context", () => {
    const e = new ProxyError("bad url", "INVALID_URL", { url: "x" });
    expect(e.name).toBe("ProxyError");
    expect(e.code).toBe("INVALID_URL");
    expect(e.context?.url).toBe("x");
    expect(e instanceof Error).toBe(true);
  });
});
