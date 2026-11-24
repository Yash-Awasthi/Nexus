// SPDX-License-Identifier: Apache-2.0
/**
 * Context mention search OWNER — extracted from api-bridge.ts.
 *
 * The composer's @kb, @file, @symbol and @web pickers, plus the prompt blocks
 * the chat council builds from those mentions. Workspace reads stay opt-in
 * (`NEXUS_WORKSPACE_DIR`); the server's own directory is never exposed.
 *
 * The memory manager, scraper and web-search pipeline are bridge-owned
 * singletons, so they are injected rather than duplicated.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope).
 */

import fs from "node:fs";
import path from "node:path";

import type { AdaptiveScraper } from "@nexus/adaptive-scraper";
import type { MemoryManager } from "@nexus/memory";
import type { RetrievalSource, ScoredChunk, SourceRetrieverFn } from "@nexus/search/retrieval";
import { UNTRUSTED_NOTE, screenUntrusted } from "@nexus/shared";
import type { FastifyInstance } from "fastify";

import { gatherSources, type SourceSet } from "../lib/citations.ts";
import { screenForPrompt } from "../lib/injection-classifier.ts";
import { unsafeUrlReason } from "../lib/public-url.ts";
import { CODE_EXT, collectWorkspaceFiles, searchSymbols, workspaceRoot } from "../lib/symbols.ts";

import { listKbsFor, searchKb } from "./kb.ts";

/** One hit from the configured web-search provider chain. */
export interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
  score: number;
}

interface WebSearchResult {
  results: WebSearchHit[];
  provider: string | null;
  error?: string;
}

/** Bridge-owned services the context routes and chat prompts read. */
export interface ContextRoutesDeps {
  getMemory: () => MemoryManager;
  getScraper: () => AdaptiveScraper;
  webSearch: (
    query: string,
    opts?: { provider?: string; max?: number },
  ) => Promise<WebSearchResult>;
}

/** The @kb and @web mentions as numbered sources, each kind retrieved in parallel. */
export async function citationSources(
  deps: ContextRoutesDeps,
  raw: unknown,
  userId: string | undefined,
  message: string,
): Promise<SourceSet> {
  const mentions = (Array.isArray(raw) ? raw.slice(0, 8) : []) as {
    type?: unknown;
    value?: unknown;
  }[];
  const valuesOf = (type: string) =>
    mentions
      .filter((m) => m?.type === type)
      .map((m) => String(m.value ?? "").trim())
      .filter(Boolean);
  const kbs = valuesOf("kb");
  const pages = valuesOf("web").filter((url) => !unsafeUrlReason(url));
  const retrievers = new Map<RetrievalSource, SourceRetrieverFn>();
  if (kbs.length) {
    retrievers.set("knowledge_base", async (query, limit) => {
      const hits = (
        await Promise.all(kbs.map((kb) => searchKb(deps.getMemory(), userId, query, kb, limit)))
      ).flat();
      return hits.map((h, i) => ({
        id: `kb:${h.kbId}:${i}`,
        docId: `${h.kbId}/${h.docName}`,
        docName: h.docName || h.kbId,
        text: h.text,
        score: h.score,
        source: "knowledge_base" as const,
      }));
    });
  }
  if (pages.length) {
    retrievers.set("web", async () => {
      const chunks: ScoredChunk[] = [];
      for (const url of pages) {
        const page = await deps
          .getScraper()
          .scrape(url, { timeout: 15_000 })
          .catch(() => null);
        if (!page || !isScrapedPage(page)) continue;
        // Paragraph-sized excerpts, so a citation can point at the part that matched.
        const paras = page.text
          .slice(0, 8_000)
          .split(/\n\s*\n/)
          .filter((p) => p.trim());
        paras.slice(0, 8).forEach((text, i) =>
          chunks.push({
            id: `web:${url}:${i}`,
            docId: url,
            docName: url,
            docSource: url,
            text,
            score: 1 - i * 0.01,
            source: "web",
          }),
        );
      }
      return chunks;
    });
  }
  return gatherSources(message, retrievers);
}

/**
 * Read @-mentions from the chat composer into context for the council:
 * a workspace file's text, a symbol's definition, a web page's text.
 * Files outside the workspace root and unsafe URLs are skipped.
 */
export async function mentionContext(
  deps: ContextRoutesDeps,
  raw: unknown,
  userId: string | undefined,
  message: string,
  /** Mention types the caller reads itself (the chat council cites kb and web as sources). */
  skip: readonly string[] = [],
): Promise<string> {
  if (!Array.isArray(raw)) return "";
  const root = workspaceRoot();
  const parts: string[] = [];
  for (const m of raw.slice(0, 8) as { type?: unknown; value?: unknown }[]) {
    const type = String(m?.type ?? "");
    const value = String(m?.value ?? "").trim();
    if (!value || skip.includes(type)) continue;
    try {
      if (type === "file") {
        if (!root) continue;
        const abs = path.resolve(root, value);
        if (!abs.startsWith(root + path.sep) || path.basename(abs).startsWith(".env")) continue;
        const text = fs.readFileSync(abs, "utf8").slice(0, 20_000);
        parts.push(`### File: ${path.relative(root, abs)}\n\`\`\`\n${text}\n\`\`\``);
      } else if (type === "symbol") {
        const name = value.replace(/[^\w$]/g, "");
        const def = new RegExp(`(?:function|class|const|interface|type)\\s+${name}\\b`);
        for (const f of collectWorkspaceFiles(root)) {
          if (!CODE_EXT.has(path.extname(f))) continue;
          const src = fs.readFileSync(f, "utf8");
          const at = src.search(def);
          if (at < 0) continue;
          const lines = src.split("\n");
          const line = src.slice(0, at).split("\n").length - 1;
          const snippet = lines.slice(Math.max(0, line - 2), line + 40).join("\n");
          parts.push(
            `### Symbol: ${name} (${path.relative(root ?? "", f)}:${line + 1})\n\`\`\`\n${snippet}\n\`\`\``,
          );
          break;
        }
      } else if (type === "kb") {
        const hits = await searchKb(deps.getMemory(), userId, message, value, 5);
        if (hits.length) {
          const excerpts = hits
            .map((h) => `[${h.docName}]\n${screenUntrusted(h.text).text}`)
            .join("\n\n");
          parts.push(`### Knowledge base excerpts. ${UNTRUSTED_NOTE}\n${excerpts}`);
        }
      } else if (type === "web") {
        if (unsafeUrlReason(value)) continue;
        const page = await deps.getScraper().scrape(value, { timeout: 15_000 });
        if (isScrapedPage(page)) {
          const [text] = await screenForPrompt([page.text.slice(0, 8_000)]);
          parts.push(`### Web page: ${value}. ${UNTRUSTED_NOTE}\n${text}`);
        }
      }
    } catch {
      parts.push(`### ${type}: ${value}\n(could not be read)`);
    }
  }
  return parts.length ? `The user referenced this context:\n\n${parts.join("\n\n")}` : "";
}

/** The scraper returns a plain error record instead of a page when a fetch fails. */
function isScrapedPage(page: unknown): page is { text: string } {
  return (
    typeof page === "object" &&
    page !== null &&
    "text" in page &&
    typeof (page as { text?: unknown }).text === "string"
  );
}

/** Register the /context/* mention pickers. */
export async function contextRoutes(app: FastifyInstance, deps: ContextRoutesDeps): Promise<void> {
  /** GET /context/kb?q= — the caller's knowledge bases, for the @kb picker. */
  app.get<{ Querystring: { q?: string } }>("/context/kb", async (request, reply) => {
    const q = (request.query.q ?? "").toLowerCase();
    return reply.send(
      listKbsFor(request.nexusUserId)
        .filter((k) => k.name.toLowerCase().includes(q))
        .map((k) => ({ name: k.name, path: k.id, kind: `${k.documents.length} docs` })),
    );
  });

  /** GET /context/files?q= — workspace files matching the query. */
  app.get<{ Querystring: { q?: string } }>("/context/files", async (request, reply) => {
    const q = (request.query.q ?? "").toLowerCase();
    if (!q) return reply.send([]);
    const matches: { path: string; name: string; size: number }[] = [];
    for (const f of collectWorkspaceFiles(workspaceRoot())) {
      const base = path.basename(f);
      if (!base.toLowerCase().includes(q) && !f.toLowerCase().includes(q)) continue;
      let size = 0;
      try {
        size = fs.statSync(f).size;
      } catch {
        /* race */
      }
      matches.push({ path: path.relative(workspaceRoot() ?? "", f), name: base, size });
      if (matches.length >= 50) break;
    }
    return reply.send(matches);
  });

  /** GET /context/symbols?q= — language-server symbols, with a regex fallback. */
  app.get<{ Querystring: { q?: string } }>("/context/symbols", async (request, reply) => {
    const hits = await searchSymbols(request.nexusUserId, request.query.q ?? "");
    return reply.send(hits);
  });

  /**
   * GET /context/web?q= — live results from the configured search provider.
   *
   * This feeds the `@web` mention picker in the chat composer, so anything it
   * returns is quoted into a deliberation as fact. With no provider configured
   * it returns nothing and names what is missing, rather than anything
   * plausible-looking.
   */
  app.get<{ Querystring: { q?: string } }>("/context/web", async (request, reply) => {
    const q = (request.query.q ?? "").trim();
    if (!q) return reply.send([]);
    const { results, provider, error } = await deps.webSearch(q);
    if (!provider) {
      return reply.send({
        results: [],
        message: `No search provider answered${error ? ` (${error})` : ""}.`,
      });
    }
    return reply.send(
      results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, provider })),
    );
  });
}
