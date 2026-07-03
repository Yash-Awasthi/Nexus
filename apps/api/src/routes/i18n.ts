// SPDX-License-Identifier: Apache-2.0
/**
 * i18n routes — powered by @nexus/i18n.
 *
 * Ships English (en) and Hindi (hi) built-in catalogs.
 * Consumers can register additional locales via POST /i18n/catalog.
 *
 * GET  /i18n/locale              — detect locale from Accept-Language header
 * GET  /i18n/locales             — list all registered locales
 * GET  /i18n/translate           — translate a key (?key=&locale=&count=)
 * POST /i18n/translate/batch     — translate multiple keys at once
 * POST /i18n/catalog             — register translations for a locale (admin)
 * GET  /i18n/catalog/:locale     — dump full catalog for a locale
 */

import {
  I18n,
  TranslationCatalog,
  detectLocale,
  formatNumber,
  formatDate,
  EN_CATALOG,
  HI_CATALOG,
} from "@nexus/i18n";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Catalog + I18n singleton ──────────────────────────────────────────────────

const catalog = new TranslationCatalog();
catalog.register("en", EN_CATALOG);
catalog.register("hi", HI_CATALOG);

// Cached locale list — catalog.locales() allocates a new array each call.
// Rebuilt only when POST /i18n/catalog registers a new locale.
let _localesCache: string[] = catalog.locales();
const SUPPORTED_LOCALES = () => _localesCache;

// Per-locale I18n cache — avoids allocating a new instance + compiling the
// placeholder regex on every request. Invalidated alongside _localesCache.
const _i18nCache = new Map<string, I18n>();

function i18nFor(locale: string): I18n {
  let instance = _i18nCache.get(locale);
  if (!instance) {
    instance = new I18n(catalog, { locale, fallbackLocale: "en" });
    _i18nCache.set(locale, instance);
  }
  return instance;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function i18nRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /i18n/locale
   *
   * Detect best locale from Accept-Language request header.
   * Query override: ?locale=hi
   */
  app.get<{ Querystring: { locale?: string } }>(
    "/i18n/locale",
    { preHandler: requireAuth },
    async (request, reply) => {
      const override = request.query.locale;
      if (override) {
        const supported = SUPPORTED_LOCALES();
        const resolved = supported.includes(override) ? override : "en";
        return reply.send({ locale: resolved, supported, source: "query" });
      }
      const acceptLang = (request.headers["accept-language"] as string | undefined) ?? "";
      const supported = SUPPORTED_LOCALES();
      const locale = detectLocale(acceptLang, supported, "en");
      return reply.send({ locale, supported, source: "accept-language" });
    },
  );

  /** GET /i18n/locales — list registered locales */
  app.get("/i18n/locales", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({ locales: SUPPORTED_LOCALES() });
  });

  /**
   * GET /i18n/translate?key=app.title&locale=hi&count=2
   *
   * Translate a single key. count triggers plural form selection.
   */
  app.get<{ Querystring: { key: string; locale?: string; count?: string } }>(
    "/i18n/translate",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { key, locale = "en", count } = request.query;
      if (!key) return reply.code(400).send({ error: "key is required" });

      const i18n = i18nFor(locale);
      const interpolations = count !== undefined ? { count: parseInt(count, 10) } : undefined;
      const value = i18n.t(key, interpolations);
      return reply.send({ key, locale, value, missing: value === key });
    },
  );

  /**
   * POST /i18n/translate/batch
   *
   * Body: { keys: string[], locale?: string, interpolations?: Record<string, Record<string,string|number>> }
   * Returns: { results: { key, value, missing }[] }
   */
  app.post<{
    Body: {
      keys: string[];
      locale?: string;
      interpolations?: Record<string, Record<string, string | number>>;
    };
  }>("/i18n/translate/batch", { preHandler: requireAuth }, async (request, reply) => {
    const { keys, locale = "en", interpolations = {} } = request.body ?? {};
    if (!Array.isArray(keys) || keys.length === 0) {
      return reply.code(400).send({ error: "keys array is required" });
    }
    if (keys.length > 200) return reply.code(400).send({ error: "max 200 keys per batch" });

    const i18n = i18nFor(locale);
    const results = keys.map((key) => {
      const interp = interpolations[key];
      const value = i18n.t(key, interp);
      return { key, value, missing: value === key };
    });
    return reply.send({ results, locale, total: results.length });
  });

  /**
   * POST /i18n/catalog
   *
   * Register translations for a locale. Merges with existing entries.
   * Body: { locale: string, translations: Record<string, string | { one, other, zero? }> }
   */
  app.post<{
    Body: { locale: string; translations: Record<string, unknown> };
  }>("/i18n/catalog", { preHandler: requireAuth }, async (request, reply) => {
    const { locale, translations } = request.body ?? {};
    if (!locale || typeof locale !== "string")
      return reply.code(400).send({ error: "locale is required" });
    if (!translations || typeof translations !== "object")
      return reply.code(400).send({ error: "translations object is required" });

    catalog.register(locale, translations as Record<string, string>);
    _localesCache = catalog.locales();
    _i18nCache.delete(locale);
    return reply.code(201).send({ ok: true, locale, added: Object.keys(translations).length });
  });

  /**
   * GET /i18n/catalog/:locale — dump all translation keys for a locale
   */
  app.get<{ Params: { locale: string } }>(
    "/i18n/catalog/:locale",
    { preHandler: requireAuth },
    async (request, reply) => {
      const dict = catalog.get(request.params.locale);
      if (!dict) return reply.code(404).send({ error: "locale_not_found" });
      return reply.send({
        locale: request.params.locale,
        translations: dict,
        total: Object.keys(dict).length,
      });
    },
  );

  /**
   * GET /i18n/format/number?value=1234567&locale=en
   * GET /i18n/format/date?value=2026-06-18&locale=en&style=long
   */
  app.get<{ Querystring: { value: string; locale?: string; style?: string } }>(
    "/i18n/format/number",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { value, locale = "en" } = request.query;
      const num = parseFloat(value);
      if (isNaN(num)) return reply.code(400).send({ error: "value must be a number" });
      return reply.send({ formatted: formatNumber(num, locale) });
    },
  );

  app.get<{ Querystring: { value: string; locale?: string; style?: string } }>(
    "/i18n/format/date",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { value, locale = "en", style = "medium" } = request.query;
      const date = new Date(value);
      if (isNaN(date.getTime()))
        return reply.code(400).send({ error: "value must be a valid date string" });
      return reply.send({
        formatted: formatDate(date, locale, style as "short" | "medium" | "long" | "full"),
      });
    },
  );
}
