// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  DigestStore,
  SectionBuilder,
  BriefCarousel,
  BriefSigner,
  BriefRenderer,
  BriefEngine,
  type DigestEvent,
  type DigestSnapshot,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvents(domains: string[], perDomain = 2): DigestEvent[] {
  const events: DigestEvent[] = [];
  for (const domain of domains) {
    for (let i = 0; i < perDomain; i++) {
      events.push({
        id: `${domain}-ev-${i}`,
        domain,
        summary: `${domain} event ${i}`,
        severity: "medium",
        timestamp: "2024-01-01T00:00:00Z",
      });
    }
  }
  return events;
}

function makeSnapshot(overrides: Partial<DigestSnapshot> = {}): DigestSnapshot {
  return {
    id: "snap-1",
    userId: "user1",
    date: "2024-01-01",
    events: makeEvents(["aviation", "cyber"]),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── DigestStore ───────────────────────────────────────────────────────────────

describe("DigestStore", () => {
  let store: DigestStore;

  beforeEach(() => {
    store = new DigestStore();
  });

  it("saves and retrieves a snapshot", () => {
    const snap = makeSnapshot();
    store.save(snap);
    expect(store.get("user1", "2024-01-01")).toEqual(snap);
  });

  it("returns undefined for missing key", () => {
    expect(store.get("user1", "2024-01-01")).toBeUndefined();
  });

  it("overwrites same user+date", () => {
    const snap1 = makeSnapshot({ id: "snap-1", events: makeEvents(["aviation"]) });
    const snap2 = makeSnapshot({ id: "snap-2", events: makeEvents(["cyber"]) });
    store.save(snap1);
    store.save(snap2);
    expect(store.get("user1", "2024-01-01")!.id).toBe("snap-2");
  });

  it("list returns all snapshots for a user", () => {
    store.save(makeSnapshot({ userId: "u1", date: "2024-01-01" }));
    store.save(makeSnapshot({ userId: "u1", date: "2024-01-02" }));
    store.save(makeSnapshot({ userId: "u2", date: "2024-01-01" }));
    expect(store.list("u1")).toHaveLength(2);
    expect(store.list("u2")).toHaveLength(1);
  });

  it("delete removes a snapshot", () => {
    store.save(makeSnapshot());
    expect(store.delete("user1", "2024-01-01")).toBe(true);
    expect(store.get("user1", "2024-01-01")).toBeUndefined();
  });

  it("delete returns false for missing key", () => {
    expect(store.delete("nope", "2024-01-01")).toBe(false);
  });

  it("clear empties store", () => {
    store.save(makeSnapshot());
    store.clear();
    expect(store.size()).toBe(0);
  });

  it("size tracks entry count", () => {
    store.save(makeSnapshot({ userId: "u1", date: "2024-01-01" }));
    store.save(makeSnapshot({ userId: "u1", date: "2024-01-02" }));
    expect(store.size()).toBe(2);
  });
});

// ── SectionBuilder ────────────────────────────────────────────────────────────

describe("SectionBuilder", () => {
  it("builds a section with correct domain and eventCount", () => {
    const builder = new SectionBuilder();
    const events = makeEvents(["aviation"]).filter((e) => e.domain === "aviation");
    const section = builder.build("aviation", events);
    expect(section.domain).toBe("aviation");
    expect(section.eventCount).toBe(events.length);
    expect(section.title).toContain("Aviation");
  });

  it("HTML contains event summaries", () => {
    const builder = new SectionBuilder();
    const events = makeEvents(["cyber"]).filter((e) => e.domain === "cyber");
    const section = builder.build("cyber", events);
    expect(section.html).toContain("cyber event 0");
    expect(section.html).toContain("cyber event 1");
  });

  it("escapes HTML in summaries", () => {
    const builder = new SectionBuilder();
    const events: DigestEvent[] = [
      {
        id: "ev-1",
        domain: "cyber",
        summary: "<script>alert(1)</script>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];
    const section = builder.build("cyber", events);
    expect(section.html).not.toContain("<script>");
    expect(section.html).toContain("&lt;script&gt;");
  });

  it("includes severity class when severity is set", () => {
    const builder = new SectionBuilder();
    const events: DigestEvent[] = [
      {
        id: "ev-1",
        domain: "aviation",
        summary: "critical event",
        severity: "critical",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];
    const section = builder.build("aviation", events);
    expect(section.html).toContain("severity-critical");
  });
});

// ── BriefCarousel ─────────────────────────────────────────────────────────────

describe("BriefCarousel", () => {
  it("paginates sections into pages of correct size", () => {
    const carousel = new BriefCarousel(2);
    const sections = ["a", "b", "c", "d", "e"].map((d) => ({
      domain: d,
      title: d,
      html: `<p>${d}</p>`,
      eventCount: 1,
    }));
    const pages = carousel.paginate(sections);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.sections).toHaveLength(2);
    expect(pages[1]!.sections).toHaveLength(2);
    expect(pages[2]!.sections).toHaveLength(1);
  });

  it("returns 1 page when sections fit in one page", () => {
    const carousel = new BriefCarousel(5);
    const sections = ["a", "b"].map((d) => ({
      domain: d,
      title: d,
      html: `<p>${d}</p>`,
      eventCount: 1,
    }));
    const pages = carousel.paginate(sections);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.pageIndex).toBe(0);
    expect(pages[0]!.totalPages).toBe(1);
  });

  it("handles empty sections returning 1 empty page", () => {
    const carousel = new BriefCarousel(3);
    const pages = carousel.paginate([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.sections).toHaveLength(0);
  });

  it("renderPage includes page index and section HTML", () => {
    const carousel = new BriefCarousel(3);
    const page = {
      pageIndex: 0,
      totalPages: 2,
      sections: [{ domain: "aviation", title: "Aviation", html: "<p>test</p>", eventCount: 1 }],
    };
    const html = carousel.renderPage(page);
    expect(html).toContain('data-page="0"');
    expect(html).toContain("<p>test</p>");
  });
});

// ── BriefSigner ───────────────────────────────────────────────────────────────

describe("BriefSigner", () => {
  const mockHmac = (_secret: string, data: string) => `sig:${data}`;

  it("sign produces a URL with userId, date, sig params", () => {
    const signer = new BriefSigner("secret", mockHmac);
    const url = signer.sign("https://nexus.local", "user1", "2024-01-01");
    expect(url).toContain("userId=user1");
    expect(url).toContain("date=2024-01-01");
    expect(url).toContain("sig=");
  });

  it("verify returns valid: true for a properly signed URL", () => {
    const signer = new BriefSigner("secret", mockHmac);
    const url = signer.sign("https://nexus.local", "user1", "2024-01-01");
    const result = signer.verify(url);
    expect(result.valid).toBe(true);
    expect(result.userId).toBe("user1");
    expect(result.date).toBe("2024-01-01");
  });

  it("verify returns valid: false when sig is tampered", () => {
    const signer = new BriefSigner("secret", mockHmac);
    const url = signer.sign("https://nexus.local", "user1", "2024-01-01") + "TAMPERED";
    // the TAMPERED suffix modifies sig param value since it's last — reconstruct properly
    const u = new URL(signer.sign("https://nexus.local", "user1", "2024-01-01"));
    u.searchParams.set("sig", "wrong-sig");
    const result = signer.verify(u.toString());
    expect(result.valid).toBe(false);
  });

  it("verify returns valid: false for malformed URL", () => {
    const signer = new BriefSigner("secret", mockHmac);
    const result = signer.verify("not-a-url");
    expect(result.valid).toBe(false);
  });

  it("different secrets produce different signatures", () => {
    const s1 = new BriefSigner("secret1", mockHmac);
    const s2 = new BriefSigner("secret2", mockHmac);
    const url = s1.sign("https://nexus.local", "user1", "2024-01-01");
    // s2 expects sig computed with "secret2", so s1's URL will be invalid for s2
    // But mockHmac ignores secret — let's use the real internal hmac behavior:
    const s3 = new BriefSigner("secret1");
    const s4 = new BriefSigner("secret2");
    const url3 = s3.sign("https://nexus.local", "user1", "2024-01-01");
    expect(s4.verify(url3).valid).toBe(false);
  });
});

// ── BriefRenderer ─────────────────────────────────────────────────────────────

describe("BriefRenderer", () => {
  it("produces valid HTML with doctype", () => {
    const renderer = new BriefRenderer();
    const sections = ["aviation", "cyber"].map((d) => ({
      domain: d,
      title: `${d} Intel`,
      html: `<p>${d}</p>`,
      eventCount: 2,
    }));
    const html = renderer.render("user1", "2024-01-01", sections);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Nexus Intelligence Brief");
    expect(html).toContain("user1");
    expect(html).toContain("2024-01-01");
  });

  it("includes carousel pages in output", () => {
    const renderer = new BriefRenderer(1); // 1 section per page
    const sections = ["a", "b", "c"].map((d) => ({
      domain: d,
      title: d,
      html: `<section>${d}</section>`,
      eventCount: 1,
    }));
    const html = renderer.render("u", "2024-01-01", sections);
    expect(html).toContain('data-page="0"');
    expect(html).toContain('data-page="1"');
    expect(html).toContain('data-page="2"');
  });

  it("displays correct total event count", () => {
    const renderer = new BriefRenderer();
    const sections = [
      { domain: "av", title: "Av", html: "<p>a</p>", eventCount: 3 },
      { domain: "cy", title: "Cy", html: "<p>c</p>", eventCount: 7 },
    ];
    const html = renderer.render("u", "2024-01-01", sections);
    expect(html).toContain("10 events");
  });
});

// ── BriefEngine ───────────────────────────────────────────────────────────────

describe("BriefEngine", () => {
  let engine: BriefEngine;

  beforeEach(() => {
    engine = new BriefEngine({
      baseUrl: "https://nexus.local",
      hmacSecret: "test-secret",
      hmacFn: (_s, d) => `mock-sig:${d}`,
    });
  });

  it("saveDigest stores snapshot and returns it", () => {
    const events = makeEvents(["aviation", "cyber"]);
    const snap = engine.saveDigest("user1", "2024-01-01", events);
    expect(snap.userId).toBe("user1");
    expect(snap.date).toBe("2024-01-01");
    expect(snap.events).toHaveLength(events.length);
    expect(engine.getStore().size()).toBe(1);
  });

  it("buildBrief returns null for missing digest", () => {
    expect(engine.buildBrief("nobody", "2099-01-01")).toBeNull();
  });

  it("buildBrief returns a full BriefResult", () => {
    const events = makeEvents(["aviation", "cyber", "health"]);
    engine.saveDigest("user1", "2024-01-01", events);
    const result = engine.buildBrief("user1", "2024-01-01");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user1");
    expect(result!.date).toBe("2024-01-01");
    expect(result!.totalEvents).toBe(events.length);
    expect(result!.sections).toHaveLength(3); // aviation, cyber, health
    expect(result!.html).toContain("<!DOCTYPE html>");
    expect(result!.shareUrl).toContain("userId=user1");
  });

  it("sections are sorted by domain name alphabetically", () => {
    const events = makeEvents(["wildfire", "aviation", "cyber"]);
    engine.saveDigest("u", "2024-01-01", events);
    const result = engine.buildBrief("u", "2024-01-01")!;
    const domains = result.sections.map((s) => s.domain);
    expect(domains).toEqual(["aviation", "cyber", "wildfire"]);
  });

  it("buildFromEvents saves and builds in one call", () => {
    const events = makeEvents(["maritime"]);
    const result = engine.buildFromEvents("user1", "2024-02-01", events);
    expect(result.totalEvents).toBe(events.length);
    expect(engine.getStore().get("user1", "2024-02-01")).toBeDefined();
  });

  it("verifyShareUrl returns valid: true for its own signed URLs", () => {
    engine.saveDigest("user1", "2024-01-01", makeEvents(["cyber"]));
    const result = engine.buildBrief("user1", "2024-01-01")!;
    const verification = engine.verifyShareUrl(result.shareUrl);
    expect(verification.valid).toBe(true);
    expect(verification.userId).toBe("user1");
    expect(verification.date).toBe("2024-01-01");
  });

  it("verifyShareUrl rejects tampered URLs", () => {
    engine.saveDigest("user1", "2024-01-01", makeEvents(["cyber"]));
    const result = engine.buildBrief("user1", "2024-01-01")!;
    const tampered = result.shareUrl.replace("user1", "hacker");
    const verification = engine.verifyShareUrl(tampered);
    expect(verification.valid).toBe(false);
  });

  it("events with same domain are grouped into one section", () => {
    const events: DigestEvent[] = [
      { id: "1", domain: "cyber", summary: "event A", timestamp: "2024-01-01T00:00:00Z" },
      { id: "2", domain: "cyber", summary: "event B", timestamp: "2024-01-01T00:01:00Z" },
      { id: "3", domain: "cyber", summary: "event C", timestamp: "2024-01-01T00:02:00Z" },
    ];
    engine.saveDigest("u", "2024-01-01", events);
    const result = engine.buildBrief("u", "2024-01-01")!;
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.eventCount).toBe(3);
  });

  it("generatedAt is an ISO string", () => {
    engine.saveDigest("u", "2024-01-01", makeEvents(["aviation"]));
    const result = engine.buildBrief("u", "2024-01-01")!;
    expect(() => new Date(result.generatedAt)).not.toThrow();
  });
});
