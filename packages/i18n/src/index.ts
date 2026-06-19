// SPDX-License-Identifier: Apache-2.0
/**
 * i18n — Internationalisation for the Nexus platform.
 *
 * Provides:
 *   • TranslationCatalog — load translation dictionaries per locale
 *   • I18n               — translate keys with interpolation and pluralisation
 *   • formatNumber       — locale-aware number formatting
 *   • formatDate         — locale-aware date formatting
 *   • detectLocale       — infer locale from Accept-Language header or navigator
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type Locale = string; // e.g. "en", "en-US", "hi", "ja"

/** Translation value type alias. */
export type TranslationValue = string | Record<string, string>;

/** Translation dict type alias. */
export type TranslationDict = Record<string, TranslationValue>;

/** Plural forms interface definition. */
export interface PluralForms {
  zero?: string;
  one: string;
  other: string;
}

/** I18n options interface definition. */
export interface I18nOptions {
  /** Locale to use. Default: "en" */
  locale?: Locale;
  /** Fallback locale when a key is missing in current locale. Default: "en" */
  fallbackLocale?: Locale;
  /** Placeholder format. Default: {{key}} */
  placeholderPattern?: RegExp;
}

// ── TranslationCatalog ────────────────────────────────────────────────────────

export class TranslationCatalog {
  private catalogs = new Map<Locale, TranslationDict>();

  /** Register translations for a locale. Merges with existing entries. */
  register(locale: Locale, dict: TranslationDict): this {
    const existing = this.catalogs.get(locale) ?? {};
    this.catalogs.set(locale, { ...existing, ...dict });
    return this;
  }

  get(locale: Locale): TranslationDict | undefined {
    return this.catalogs.get(locale);
  }

  has(locale: Locale): boolean {
    return this.catalogs.has(locale);
  }

  locales(): Locale[] {
    return [...this.catalogs.keys()];
  }
}

// ── I18n ──────────────────────────────────────────────────────────────────────

export class I18n {
  private locale: Locale;
  private fallback: Locale;
  private pattern: RegExp;
  private catalog: TranslationCatalog;

  constructor(catalog: TranslationCatalog, opts: I18nOptions = {}) {
    this.catalog = catalog;
    this.locale = opts.locale ?? "en";
    this.fallback = opts.fallbackLocale ?? "en";
    this.pattern = opts.placeholderPattern ?? /\{\{(\w+)\}\}/g;
  }

  setLocale(locale: Locale): this {
    this.locale = locale;
    return this;
  }

  getLocale(): Locale {
    return this.locale;
  }

  /**
   * Translate a key with optional variable interpolation.
   * Tries current locale first, then fallback.
   * Returns the key itself if not found anywhere.
   */
  t(key: string, vars?: Record<string, string | number>): string {
    const raw = this.lookup(key);
    if (!raw) return key;
    return this.interpolate(raw, vars);
  }

  /**
   * Pluralise a key based on a count.
   * The translation value for the key should be an object with `one` and `other` keys
   * (and optionally `zero`).
   */
  plural(key: string, count: number, vars?: Record<string, string | number>): string {
    const dict = this.getDict(this.locale) ?? this.getDict(this.fallback);
    if (!dict) return key;
    const forms = dict[key];
    if (typeof forms !== "object") return this.t(key, { count, ...vars });

    let form: string;
    if (count === 0 && forms["zero"]) {
      form = forms["zero"];
    } else if (count === 1) {
      form = forms["one"] ?? key;
    } else {
      form = forms["other"] ?? key;
    }
    return this.interpolate(form, { count, ...vars });
  }

  private lookup(key: string): string | undefined {
    const val = this.getDict(this.locale)?.[key];
    if (typeof val === "string") return val;
    if (!val && this.locale !== this.fallback) {
      const fb = this.getDict(this.fallback)?.[key];
      return typeof fb === "string" ? fb : undefined;
    }
    return undefined;
  }

  private getDict(locale: Locale): TranslationDict | undefined {
    return this.catalog.get(locale);
  }

  private interpolate(template: string, vars?: Record<string, string | number>): string {
    if (!vars) return template;
    this.pattern.lastIndex = 0;
    return template.replace(this.pattern, (_, key: string) =>
      vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`,
    );
  }
}

// ── Number formatting ──────────────────────────────────────────────────────────

export interface NumberFormatOptions {
  style?: "decimal" | "currency" | "percent";
  currency?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/** Format number. */
export function formatNumber(
  value: number,
  locale: Locale = "en",
  opts: NumberFormatOptions = {},
): string {
  try {
    return new Intl.NumberFormat(locale, opts).format(value);
  } catch {
    return String(value);
  }
}

// ── Date formatting ────────────────────────────────────────────────────────────

export type DateStyle = "full" | "long" | "medium" | "short";

/** Format date. */
export function formatDate(
  date: Date | string | number,
  locale: Locale = "en",
  style: DateStyle = "medium",
): string {
  try {
    const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
    return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(d);
  } catch {
    return String(date);
  }
}

// ── Locale detection ───────────────────────────────────────────────────────────

/**
 * Parse Accept-Language header and return the preferred locale.
 * e.g. "en-US,en;q=0.9,fr;q=0.8" → "en-US"
 */
export function detectLocale(
  acceptLanguage: string,
  supported: Locale[],
  fallback: Locale = "en",
): Locale {
  if (!acceptLanguage) return fallback;

  const preferences = acceptLanguage
    .split(",")
    .map((part) => {
      const [lang, q] = part.trim().split(";q=");
      return { lang: lang!.trim(), q: q ? parseFloat(q) : 1.0 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { lang } of preferences) {
    // Exact match
    if (supported.includes(lang)) return lang;
    // Base language match (e.g. "en-US" → "en")
    const base = lang.split("-")[0]!;
    const baseMatch = supported.find((s) => s === base || s.startsWith(base + "-"));
    if (baseMatch) return baseMatch;
  }

  return fallback;
}

// ── Built-in English catalog ──────────────────────────────────────────────────

export const EN_CATALOG: TranslationDict = {
  "app.title": "Nexus",
  "app.loading": "Loading…",
  "app.error": "Something went wrong.",
  "nav.dashboard": "Dashboard",
  "nav.chat": "Chat",
  "nav.memory": "Memory",
  "nav.discover": "Discover",
  "chat.placeholder": "Type a message…",
  "chat.send": "Send",
  "chat.regenerate": "Regenerate",
  "memory.empty": "No memories stored yet.",
  "memory.search": "Search memories…",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.confirm": "Are you sure?",
  "messages.count": { one: "{{count}} message", other: "{{count}} messages" },
  "results.count": { zero: "No results", one: "{{count}} result", other: "{{count}} results" },
};

/** Hi catalog. */
export const HI_CATALOG: TranslationDict = {
  "app.title": "नेक्सस",
  "app.loading": "लोड हो रहा है…",
  "nav.dashboard": "डैशबोर्ड",
  "nav.chat": "चैट",
  "chat.placeholder": "संदेश लिखें…",
  "chat.send": "भेजें",
  "common.save": "सहेजें",
  "common.cancel": "रद्द करें",
};
