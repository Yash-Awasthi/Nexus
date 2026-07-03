// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  TranslationCatalog,
  I18n,
  formatNumber,
  formatDate,
  detectLocale,
  EN_CATALOG,
  HI_CATALOG,
} from "../src/index.js";

// ── TranslationCatalog ────────────────────────────────────────────────────────

describe("TranslationCatalog", () => {
  it("registers and retrieves a locale", () => {
    const cat = new TranslationCatalog();
    cat.register("en", { hello: "Hello" });
    expect(cat.get("en")?.["hello"]).toBe("Hello");
  });

  it("merges additional entries on re-register", () => {
    const cat = new TranslationCatalog();
    cat.register("en", { a: "A" });
    cat.register("en", { b: "B" });
    expect(cat.get("en")?.["a"]).toBe("A");
    expect(cat.get("en")?.["b"]).toBe("B");
  });

  it("has() returns true for registered locales", () => {
    const cat = new TranslationCatalog();
    cat.register("fr", { hello: "Bonjour" });
    expect(cat.has("fr")).toBe(true);
    expect(cat.has("de")).toBe(false);
  });

  it("locales() returns all registered locale codes", () => {
    const cat = new TranslationCatalog();
    cat.register("en", {}).register("fr", {}).register("de", {});
    const locales = cat.locales();
    expect(locales).toContain("en");
    expect(locales).toContain("fr");
    expect(locales).toContain("de");
  });

  it("supports chaining", () => {
    const cat = new TranslationCatalog();
    expect(cat.register("en", {})).toBe(cat);
  });
});

// ── I18n.t ────────────────────────────────────────────────────────────────────

describe("I18n.t", () => {
  let i18n: I18n;

  beforeEach(() => {
    const cat = new TranslationCatalog();
    cat.register("en", EN_CATALOG);
    cat.register("hi", HI_CATALOG);
    i18n = new I18n(cat, { locale: "en" });
  });

  it("translates a simple key", () => {
    expect(i18n.t("app.title")).toBe("Nexus");
  });

  it("returns key when not found", () => {
    expect(i18n.t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("interpolates variables", () => {
    const cat = new TranslationCatalog();
    cat.register("en", { greeting: "Hello, {{name}}!" });
    const i = new I18n(cat);
    expect(i.t("greeting", { name: "Alice" })).toBe("Hello, Alice!");
  });

  it("leaves unresolved variables as-is", () => {
    const cat = new TranslationCatalog();
    cat.register("en", { msg: "Hello, {{name}}!" });
    const i = new I18n(cat);
    expect(i.t("msg")).toBe("Hello, {{name}}!");
  });

  it("falls back to fallback locale", () => {
    i18n.setLocale("hi");
    // "app.error" is not in HI_CATALOG, so should fall back to EN
    expect(i18n.t("app.error")).toBe("Something went wrong.");
  });

  it("uses hi locale when available", () => {
    i18n.setLocale("hi");
    expect(i18n.t("app.title")).toBe("नेक्सस");
  });

  it("getLocale returns current locale", () => {
    i18n.setLocale("hi");
    expect(i18n.getLocale()).toBe("hi");
  });

  it("setLocale supports chaining", () => {
    expect(i18n.setLocale("en")).toBe(i18n);
  });
});

// ── I18n.plural ───────────────────────────────────────────────────────────────

describe("I18n.plural", () => {
  let i18n: I18n;

  beforeEach(() => {
    const cat = new TranslationCatalog();
    cat.register("en", EN_CATALOG);
    i18n = new I18n(cat, { locale: "en" });
  });

  it("uses 'one' form for count=1", () => {
    expect(i18n.plural("messages.count", 1)).toBe("1 message");
  });

  it("uses 'other' form for count>1", () => {
    expect(i18n.plural("messages.count", 5)).toBe("5 messages");
  });

  it("uses 'zero' form for count=0 when defined", () => {
    expect(i18n.plural("results.count", 0)).toBe("No results");
  });

  it("falls back to 'other' when 'zero' not defined", () => {
    expect(i18n.plural("messages.count", 0)).toBe("0 messages");
  });

  it("interpolates custom vars alongside count", () => {
    const cat = new TranslationCatalog();
    cat.register("en", {
      items: { one: "{{count}} item in {{place}}", other: "{{count}} items in {{place}}" },
    });
    const i = new I18n(cat);
    expect(i.plural("items", 1, { place: "cart" })).toBe("1 item in cart");
    expect(i.plural("items", 3, { place: "cart" })).toBe("3 items in cart");
  });
});

// ── formatNumber ──────────────────────────────────────────────────────────────

describe("formatNumber", () => {
  it("formats a decimal number", () => {
    const r = formatNumber(1234567.89, "en");
    expect(r).toContain("1,234,567");
  });

  it("formats currency", () => {
    const r = formatNumber(99.99, "en", { style: "currency", currency: "USD" });
    expect(r).toContain("99.99");
    expect(r).toContain("$");
  });

  it("formats percentage", () => {
    const r = formatNumber(0.75, "en", { style: "percent" });
    expect(r).toContain("75");
    expect(r).toContain("%");
  });

  it("handles graceful fallback for invalid locale", () => {
    // Should not throw
    const r = formatNumber(42, "invalid-locale-xyz");
    expect(r).toBeTruthy();
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  const testDate = new Date("2026-06-14T12:00:00Z");

  it("formats a Date object", () => {
    const r = formatDate(testDate, "en", "medium");
    expect(r).toContain("2026");
  });

  it("formats an ISO string", () => {
    const r = formatDate("2026-06-14T12:00:00Z", "en", "short");
    expect(r).toBeTruthy();
  });

  it("formats a timestamp number", () => {
    const r = formatDate(testDate.getTime(), "en", "short");
    expect(r).toBeTruthy();
  });

  it("handles graceful fallback for invalid date", () => {
    // Should not throw
    const r = formatDate("not-a-date", "en");
    expect(r).toBeTruthy();
  });
});

// ── detectLocale ──────────────────────────────────────────────────────────────

describe("detectLocale", () => {
  const supported = ["en", "hi", "fr", "de", "ja"];

  it("returns exact match", () => {
    expect(detectLocale("fr", supported)).toBe("fr");
  });

  it("returns best q-value match", () => {
    expect(detectLocale("en;q=0.8,fr;q=0.9", supported)).toBe("fr");
  });

  it("matches base language", () => {
    expect(detectLocale("en-US", supported)).toBe("en");
  });

  it("returns fallback for unsupported locale", () => {
    expect(detectLocale("zh-CN", supported, "en")).toBe("en");
  });

  it("returns fallback for empty header", () => {
    expect(detectLocale("", supported, "en")).toBe("en");
  });

  it("handles multi-part Accept-Language", () => {
    expect(detectLocale("en-US,en;q=0.9,hi;q=0.8", supported)).toBe("en");
  });
});

// ── Built-in catalogs ─────────────────────────────────────────────────────────

describe("EN_CATALOG", () => {
  it("has expected keys", () => {
    expect(EN_CATALOG["app.title"]).toBe("Nexus");
    expect(EN_CATALOG["chat.send"]).toBe("Send");
    expect(typeof EN_CATALOG["messages.count"]).toBe("object");
  });
});

describe("HI_CATALOG", () => {
  it("has Hindi translations", () => {
    expect(HI_CATALOG["app.title"]).toBe("नेक्सस");
    expect(HI_CATALOG["chat.send"]).toBe("भेजें");
  });
});
