// SPDX-License-Identifier: Apache-2.0
/**
 * §16.6 split — research / legal document adapters.
 * (PreprintsFeed · ArxivFeed · EdgarFeed · LegislativeFeed · EurLexFeed +
 *  celexDocType) — the XML-seam feeds live here.
 */
import {
  buildMockResponse,
  daysAgo,
  xmlAttr,
  xmlBlocks,
  FeedAdapter,
  FeedAdapterOptions,
  FeedEvent,
} from "../base.js";
import type {
  DirectiveEvent,
  FilingEvent,
  LegislationEvent,
  PreprintEvent,
} from "../index.js";

// ── Preprints — bioRxiv/medRxiv details API (no key required) ──────────────────

export class PreprintsFeed extends FeedAdapter<PreprintEvent> {
  readonly domain = "preprints";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.biorxiv.org", ...opts });
  }

  async fetch(opts?: {
    server?: "biorxiv" | "medrxiv";
    from?: string;
    to?: string;
    category?: string;
  }): Promise<PreprintEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const server = opts?.server ?? "biorxiv";
    const to = opts?.to ?? daysAgo(0);
    const from = opts?.from ?? daysAgo(7);
    const url = `${this.baseUrl}/details/${server}/${from}/${to}/0`;

    try {
      const raw = await this.http(url, this.buildHeaders());
      if (Array.isArray(raw)) return raw as PreprintEvent[];

      type Item = {
        doi?: string;
        title?: string;
        authors?: string;
        date?: string;
        version?: string;
        category?: string;
        abstract?: string;
        published?: string;
      };
      const collection = (raw as { collection?: Item[] } | null)?.collection ?? [];
      if (!Array.isArray(collection) || collection.length === 0) {
        return buildMockResponse<PreprintEvent>("preprints");
      }
      const category = opts?.category?.toLowerCase();
      return collection
        .filter((p) => !category || (p.category ?? "").toLowerCase() === category)
        .map((p, i) => {
          const doi = p.doi ?? "";
          // bioRxiv returns "NA" for unpublished — surface graduation to a journal as severity.
          const published = p.published && p.published !== "NA" ? p.published : undefined;
          return {
            id: doi ? `${doi}v${p.version ?? "1"}` : `biorxiv-${i}`,
            timestamp: p.date ? new Date(p.date).toISOString() : new Date().toISOString(),
            severity: (published ? "medium" : "low") as FeedEvent["severity"],
            source: server,
            summary: p.title ?? "(untitled)",
            title: p.title ?? "(untitled)",
            doi,
            authors: p.authors,
            category: p.category,
            date: p.date ?? "",
            version: p.version,
            url: doi ? `https://doi.org/${doi}` : undefined,
            published,
            metadata: { abstract: p.abstract },
          };
        });
    } catch {
      return buildMockResponse<PreprintEvent>("preprints");
    }
  }
}

// ── arXiv — Atom XML query API (no key required) ───────────────────────────────
// The arXiv API returns Atom XML (content-type application/atom+xml), so the http
// seam hands back a string, not JSON. We extract entries with the tiny Atom helper
// above and map onto PreprintEvent (same shape as bioRxiv/medRxiv). arXiv mints a
// canonical DataCite DOI (10.48550/arXiv.<id>); a journal DOI, when present, lands
// in `published` to mirror bioRxiv's graduation semantics.

export class ArxivFeed extends FeedAdapter<PreprintEvent> {
  readonly domain = "arxiv";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "http://export.arxiv.org/api", ...opts });
  }

  async fetch(opts?: {
    /** arXiv category, e.g. "cs.AI" (default). */
    category?: string;
    /** Raw search_query override (takes precedence over category). */
    search?: string;
    maxResults?: number;
  }): Promise<PreprintEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const searchQuery = opts?.search ?? `cat:${opts?.category ?? "cs.AI"}`;
    const max = opts?.maxResults ?? 25;
    const url =
      `${this.baseUrl}/query?search_query=${encodeURIComponent(searchQuery)}` +
      `&start=0&max_results=${max}&sortBy=submittedDate&sortOrder=descending`;

    try {
      const raw = await this.http(url, this.buildHeaders());
      const xml = typeof raw === "string" ? raw : "";
      const entries = xmlBlocks(xml, "entry");
      if (entries.length === 0) return buildMockResponse<PreprintEvent>("arxiv");

      return entries.map((entry, i) => {
        const absUrl = xmlBlocks(entry, "id")[0] ?? "";
        // "http://arxiv.org/abs/2401.12345v2" → id "2401.12345v2", base "2401.12345"
        const arxivId = absUrl.split("/abs/")[1] ?? `arxiv-${i}`;
        const versionMatch = /v(\d+)$/.exec(arxivId);
        const idNoVersion = arxivId.replace(/v\d+$/, "");
        const published = xmlBlocks(entry, "published")[0] ?? "";
        const journalDoi = xmlBlocks(entry, "doi")[0]; // arxiv:doi — only if published
        const authors = xmlBlocks(entry, "name").join(", ");
        const category =
          xmlAttr(entry, "primary_category", "term") ?? xmlAttr(entry, "category", "term");

        return {
          id: arxivId,
          timestamp: published ? new Date(published).toISOString() : new Date().toISOString(),
          severity: (journalDoi ? "medium" : "low") as FeedEvent["severity"],
          source: "arxiv",
          summary: xmlBlocks(entry, "title")[0] ?? "(untitled)",
          title: xmlBlocks(entry, "title")[0] ?? "(untitled)",
          doi: `10.48550/arXiv.${idNoVersion}`,
          authors: authors || undefined,
          category,
          date: published,
          version: versionMatch?.[1],
          url: absUrl || `https://arxiv.org/abs/${arxivId}`,
          published: journalDoi,
          metadata: { abstract: xmlBlocks(entry, "summary")[0] },
        };
      });
    } catch {
      return buildMockResponse<PreprintEvent>("arxiv");
    }
  }
}

// ── SEC EDGAR — latest filings Atom feed (no key; UA required) ─────────────────
// EDGAR serves Atom, but — unlike arXiv — `link` and `category` are ATTRIBUTES
// (self-closing tags), the `id` holds the accession number as a urn, and `summary`
// is escaped HTML (Filed/AccNo/Size). SEC's fair-access policy REQUIRES a
// descriptive User-Agent with a contact; set SEC_EDGAR_USER_AGENT (falls back to a
// generic one). Reuses the Atom helper introduced for arXiv (§13 XML seam).

export class EdgarFeed extends FeedAdapter<FilingEvent> {
  readonly domain = "edgar";
  private userAgent: string;

  constructor(opts: Partial<FeedAdapterOptions> & { userAgent?: string } = {}) {
    super({ baseUrl: "https://www.sec.gov", ...opts });
    this.userAgent =
      opts.userAgent ?? process.env["SEC_EDGAR_USER_AGENT"] ?? "Nexus Feeds (contact@nexus.local)";
  }

  async fetch(opts?: {
    /** Restrict to one form type, e.g. "8-K" (default: all recent filings). */
    formType?: string;
    count?: number;
  }): Promise<FilingEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const count = opts?.count ?? 40;
    const url =
      `${this.baseUrl}/cgi-bin/browse-edgar?action=getcurrent` +
      `&type=${encodeURIComponent(opts?.formType ?? "")}` +
      `&company=&dateb=&owner=include&count=${count}&output=atom`;

    try {
      // SEC needs a real User-Agent; Accept XML (buildHeaders' JSON accept is wrong here).
      const raw = await this.http(url, {
        "User-Agent": this.userAgent,
        Accept: "application/atom+xml",
      });
      const xml = typeof raw === "string" ? raw : "";
      const entries = xmlBlocks(xml, "entry");
      if (entries.length === 0) return buildMockResponse<FilingEvent>("edgar");

      return entries.map((entry, i) => {
        const title = xmlBlocks(entry, "title")[0] ?? "";
        // "8-K - ACME CORP (0001234567) (Filer)" → form, company, cik
        const titleMatch = /^(.+?)\s+-\s+(.+?)\s+\((\d+)\)/.exec(title);
        const formType = xmlAttr(entry, "category", "term") ?? titleMatch?.[1] ?? "";
        const company = titleMatch?.[2] ?? title;
        const idText = xmlBlocks(entry, "id")[0] ?? "";
        const accessionNumber = /accession-number=(\S+)/.exec(idText)?.[1] ?? `edgar-${i}`;
        const summary = xmlBlocks(entry, "summary")[0] ?? "";
        const filedDate = /Filed:<\/b>\s*([\d-]+)/.exec(summary)?.[1];
        const updated = xmlBlocks(entry, "updated")[0];

        return {
          id: accessionNumber,
          timestamp: updated ? new Date(updated).toISOString() : new Date().toISOString(),
          // 8-K = material current report → surface a notch higher than routine filings.
          severity: (formType.startsWith("8-K") ? "medium" : "low") as FeedEvent["severity"],
          source: "sec-edgar",
          summary: summary.replace(/<[^>]+>/g, "").trim() || title,
          formType,
          company,
          cik: titleMatch?.[3],
          accessionNumber,
          filedDate,
          url: xmlAttr(entry, "link", "href"),
        };
      });
    } catch {
      return buildMockResponse<FilingEvent>("edgar");
    }
  }
}

// ── US Congress — bill tracking (Congress.gov API; key required) ───────────────
// Congress.gov returns JSON by default (no XML seam needed), so this mirrors the
// Reddit/HN JSON feeds. The key goes in the `api_key` query param (a free
// api.data.gov key); without it we skip the call and return mock rather than fire
// a guaranteed 403. Recent activity = /bill sorted by updateDate desc.

export class LegislativeFeed extends FeedAdapter<LegislationEvent> {
  readonly domain = "legislative";
  private key?: string;

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.congress.gov/v3", ...opts });
    this.key = opts.apiKey ?? process.env["CONGRESS_GOV_API_KEY"];
  }

  async fetch(opts?: {
    /** Congress number, e.g. 118 — narrows to /bill/{congress}. */
    congress?: number;
    /** Bill type, e.g. "hr" — requires `congress`; narrows to /bill/{congress}/{type}. */
    billType?: string;
    limit?: number;
  }): Promise<LegislationEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    if (!this.key) return buildMockResponse<LegislationEvent>("legislative");

    const path = opts?.congress
      ? `/bill/${opts.congress}${opts.billType ? `/${opts.billType.toLowerCase()}` : ""}`
      : "/bill";
    const url =
      `${this.baseUrl}${path}?format=json&sort=updateDate+desc` +
      `&limit=${opts?.limit ?? 20}&api_key=${encodeURIComponent(this.key)}`;

    try {
      const raw = (await this.http(url, this.buildHeaders())) as {
        bills?: {
          congress?: number;
          type?: string;
          number?: string;
          title?: string;
          originChamber?: string;
          url?: string;
          updateDate?: string;
          latestAction?: { actionDate?: string; text?: string };
        }[];
      } | null;
      const bills = raw?.bills ?? [];
      if (bills.length === 0) return buildMockResponse<LegislationEvent>("legislative");

      return bills.map((b, i) => {
        const actionText = b.latestAction?.text ?? "";
        // Became law → high; passed a chamber → medium; otherwise routine.
        const severity: FeedEvent["severity"] = /became (public|private) law/i.test(actionText)
          ? "high"
          : /passed|agreed to/i.test(actionText)
            ? "medium"
            : "low";
        const actionDate = b.latestAction?.actionDate ?? b.updateDate;
        return {
          id:
            b.congress && b.type && b.number ? `${b.congress}-${b.type}-${b.number}` : `bill-${i}`,
          timestamp: actionDate ? new Date(actionDate).toISOString() : new Date().toISOString(),
          severity,
          source: "congress.gov",
          summary: b.title ?? `${b.type ?? ""}${b.number ?? ""}`,
          congress: b.congress ?? 0,
          billType: b.type ?? "",
          billNumber: b.number ?? "",
          title: b.title ?? "(untitled)",
          chamber: b.originChamber,
          latestAction: actionText || undefined,
          actionDate,
          url: b.url,
        };
      });
    } catch {
      return buildMockResponse<LegislationEvent>("legislative");
    }
  }
}

// ── EUR-Lex — EU legislation RSS (no key; predefined feeds by rssId) ────────────
// EUR-Lex publishes keyless RSS 2.0 feeds selected by a numeric `rssId`. Default
// 162 = "All Parliament and Council legislation" (directives + regulations +
// decisions); other verified ids: 161 Commission proposals, 165 Official Journal
// L (legislation), 164 case-law. Items are <title> ("CELEX:<id>: <text>"),
// <link>, <guid>, <pubDate>, <dc:creator>. The CELEX descriptor letter after the
// 4-digit year gives the document type (L directive, R regulation, D decision).
// Reuses the §13 XML seam (xmlBlocks is namespace-tolerant, so it reads dc:creator).

/** Map a CELEX id to its document type via the descriptor letter (sector 3 = legislation). */
function celexDocType(celex: string): string {
  const letter = /^\d\d{4}([A-Z])/.exec(celex)?.[1];
  switch (letter) {
    case "L":
      return "Directive";
    case "R":
      return "Regulation";
    case "D":
      return "Decision";
    case "H":
      return "Recommendation";
    default:
      return letter ? `Act (${letter})` : "Act";
  }
}

export class EurLexFeed extends FeedAdapter<DirectiveEvent> {
  readonly domain = "eurlex";
  private rssId: number;
  private userAgent: string;

  constructor(opts: Partial<FeedAdapterOptions> & { rssId?: number; userAgent?: string } = {}) {
    super({ baseUrl: "https://eur-lex.europa.eu", ...opts });
    // 162 = "All Parliament and Council legislation" (verified keyless RSS).
    this.rssId = opts.rssId ?? Number(process.env["EURLEX_RSS_ID"] ?? 162);
    this.userAgent =
      opts.userAgent ?? process.env["EURLEX_USER_AGENT"] ?? "Nexus Feeds (contact@nexus.local)";
  }

  async fetch(opts?: { rssId?: number }): Promise<DirectiveEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const rssId = opts?.rssId ?? this.rssId;
    const url = `${this.baseUrl}/EN/display-feed.rss?rssId=${encodeURIComponent(String(rssId))}`;

    try {
      const raw = await this.http(url, {
        "User-Agent": this.userAgent,
        Accept: "application/rss+xml",
      });
      const xml = typeof raw === "string" ? raw : "";
      const items = xmlBlocks(xml, "item");
      if (items.length === 0) return buildMockResponse<DirectiveEvent>("eurlex");

      return items.map((item, i) => {
        const title = xmlBlocks(item, "title")[0] ?? "";
        const link = xmlBlocks(item, "link")[0];
        // CELEX from "CELEX:<id>: <text>" or the ?uri=CELEX:<id> link.
        const celex =
          /^CELEX:(\S+?):/.exec(title)?.[1] ?? /uri=CELEX:(\S+)/.exec(link ?? "")?.[1] ?? "";
        const docType = celex ? celexDocType(celex) : "Act";
        const pubDate = xmlBlocks(item, "pubDate")[0];
        // Directives require national transposition → higher signal than other acts.
        const severity: FeedEvent["severity"] = docType === "Directive" ? "medium" : "low";

        return {
          id: celex || `eurlex-${i}`,
          timestamp: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          severity,
          source: "eur-lex",
          // Strip the "CELEX:<id>: " prefix for a clean summary.
          summary: title.replace(/^CELEX:\S+?:\s*/, "").trim() || title || "(untitled)",
          celex,
          docType,
          title: title.replace(/^CELEX:\S+?:\s*/, "").trim() || title || "(untitled)",
          author: xmlBlocks(item, "creator")[0],
          url: link,
          published: pubDate ? new Date(pubDate).toISOString() : undefined,
        };
      });
    } catch {
      return buildMockResponse<DirectiveEvent>("eurlex");
    }
  }
}

