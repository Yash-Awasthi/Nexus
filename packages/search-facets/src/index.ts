// SPDX-License-Identifier: Apache-2.0
/**
 * search-facets — Document search result highlighting and faceted filtering.
 *
 * Provides:
 *   • highlight()       — wrap query term occurrences in a tag
 *   • buildFacets()     — count values across a field for a result set
 *   • applyFacets()     — filter a result set by active facet selections
 *   • excerptSnippet()  — extract a short surrounding excerpt around a match
 *   • rankByRelevance() — sort results by term-frequency relevance score
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchDoc {
  id: string;
  content: string;
  metadata?: Record<string, string | string[]>;
}

/** Highlight options interface definition. */
export interface HighlightOptions {
  tag?: string; // default "mark"
  className?: string; // default "" (no class attr)
  caseSensitive?: boolean;
}

/** Facet bucket interface definition. */
export interface FacetBucket {
  value: string;
  count: number;
}

/** Facet result interface definition. */
export interface FacetResult {
  field: string;
  buckets: FacetBucket[];
}

/** Facet filter interface definition. */
export interface FacetFilter {
  field: string;
  values: string[];
}

/** Snippet options interface definition. */
export interface SnippetOptions {
  window?: number; // chars around the match; default 100
  ellipsis?: string; // default "…"
}

/** Scored doc interface definition. */
export interface ScoredDoc {
  doc: SearchDoc;
  score: number;
}

// ── highlight ─────────────────────────────────────────────────────────────────

/**
 * Wrap every occurrence of each query term in `text` with `<tag>term</tag>`.
 * Returns the highlighted text (no DOM required — pure string manipulation).
 */
export function highlight(text: string, query: string, opts: HighlightOptions = {}): string {
  const { tag = "mark", className = "", caseSensitive = false } = opts;

  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // longest first to avoid nested highlights

  if (terms.length === 0) return text;

  const classAttr = className ? ` class="${className}"` : "";
  const open = `<${tag}${classAttr}>`;
  const close = `</${tag}>`;

  let result = text;
  for (const term of terms) {
    const flags = caseSensitive ? "g" : "gi";
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, flags), (match) => `${open}${match}${close}`);
  }
  return result;
}

// ── excerptSnippet ─────────────────────────────────────────────────────────────

/**
 * Extract a short excerpt from `text` centered around the first occurrence of `query`.
 */
export function excerptSnippet(text: string, query: string, opts: SnippetOptions = {}): string {
  const { window: win = 100, ellipsis = "…" } = opts;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, win * 2) + (text.length > win * 2 ? ellipsis : "");

  const start = Math.max(0, idx - win);
  const end = Math.min(text.length, idx + query.length + win);
  const pre = start > 0 ? ellipsis : "";
  const post = end < text.length ? ellipsis : "";
  return pre + text.slice(start, end) + post;
}

// ── buildFacets ───────────────────────────────────────────────────────────────

/**
 * Build facet counts for the given metadata `fields` across a list of docs.
 */
export function buildFacets(docs: SearchDoc[], fields: string[]): FacetResult[] {
  return fields.map((field) => {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const val = doc.metadata?.[field];
      if (val === undefined) continue;
      const values = Array.isArray(val) ? val : [val];
      for (const v of values) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    const buckets: FacetBucket[] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return { field, buckets };
  });
}

// ── applyFacets ───────────────────────────────────────────────────────────────

/**
 * Filter `docs` so that every active facet filter is satisfied (AND semantics).
 * Within a single facet, multiple values are OR'd.
 */
export function applyFacets(docs: SearchDoc[], filters: FacetFilter[]): SearchDoc[] {
  if (filters.length === 0) return docs;
  return docs.filter((doc) =>
    filters.every((f) => {
      const val = doc.metadata?.[f.field];
      if (val === undefined) return false;
      const docValues = Array.isArray(val) ? val : [val];
      return f.values.some((fv) => docValues.includes(fv));
    }),
  );
}

// ── rankByRelevance ───────────────────────────────────────────────────────────

/**
 * Score and sort docs by the frequency of query terms in content.
 */
export function rankByRelevance(docs: SearchDoc[], query: string): ScoredDoc[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return docs.map((doc) => ({ doc, score: 0 }));

  const scored = docs.map((doc) => {
    const lower = doc.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let idx = -1;
      while ((idx = lower.indexOf(term, idx + 1)) !== -1) score++;
    }
    return { doc, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}
