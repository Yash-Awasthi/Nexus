// SPDX-License-Identifier: Apache-2.0
/**
 * One search across what the caller has: their knowledge bases, their knowledge graph and the
 * web, with numbered sources and, on request, an answer that cites them.
 *
 *   POST /api/search  { query, kbs?, web?, graph?, answer?, limit? }
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */
import type { MemoryManager } from "@nexus/memory";
import type { RetrievalSource, ScoredChunk, SourceRetrieverFn } from "@nexus/retrieval";
import type { FastifyInstance } from "fastify";

import { citedNumbers, numberSources, sourcesPrompt } from "../lib/citations.js";
import { screenForPrompt } from "../lib/injection-classifier.js";
import { getKGStore, searchGraph } from "../lib/knowledge-graph-store.js";

import { listKbsFor, searchKb } from "./kb.js";

interface SearchDeps {
  getMemory: () => MemoryManager;
  webSearch: (
    query: string,
    opts: { max: number },
  ) => Promise<{
    results: { title: string; url: string; snippet: string }[];
    provider: string | null;
    error?: string;
  }>;
  llm: (
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    maxTokens?: number,
  ) => Promise<string>;
}

const MIN_SCORE = 0.03;

const ANSWER_PROMPT =
  "Answer the question using only the numbered sources. Cite each claim inline as [n]. " +
  "If the sources do not answer it, say what is missing instead of guessing. Be brief.";

export async function searchRoutes(app: FastifyInstance, deps: SearchDeps): Promise<void> {
  app.post<{
    Body: {
      query?: string;
      kbs?: string[];
      web?: boolean;
      graph?: boolean;
      answer?: boolean;
      limit?: number;
    };
  }>("/search", async (request, reply) => {
    const query = request.body?.query?.trim() ?? "";
    if (!query) return reply.code(400).send({ error: "query is required" });
    if (query.length > 500)
      return reply.code(400).send({ error: "query is at most 500 characters" });
    const limit = Math.min(20, Math.max(1, Math.floor(request.body?.limit ?? 8)));
    const userId = request.nexusUserId;

    const mine = new Map(listKbsFor(userId).map((kb) => [kb.id, kb]));
    const wanted = request.body?.kbs ?? [];
    const unknown = wanted.filter((id) => !mine.has(id));
    if (unknown.length) return reply.code(404).send({ error: "knowledge base not found" });

    const notes: string[] = [];
    const retrievers = new Map<RetrievalSource, SourceRetrieverFn>();

    if (mine.size > 0) {
      retrievers.set("knowledge_base", async (q, n) => {
        // No selection means every base the caller has.
        const hits = (
          await Promise.all(
            (wanted.length ? wanted : [undefined]).map((kb) =>
              searchKb(deps.getMemory(), userId, q, kb, n),
            ),
          )
        ).flat();
        // The store always returns its nearest chunks; ones that score nothing match nothing.
        return hits
          .filter((h) => h.score > MIN_SCORE)
          .map((h) => ({
            id: `kb:${h.id}`,
            docId: `${h.kbId}/${h.docName}`,
            docName: h.docName || mine.get(h.kbId)?.name || h.kbId,
            text: h.text,
            score: h.score,
            source: "knowledge_base" as const,
            metadata: { kbId: h.kbId, kbName: mine.get(h.kbId)?.name },
          }));
      });
    }

    if (request.body?.web) {
      retrievers.set("web", async (q, n) => {
        const { results, provider, error } = await deps.webSearch(q, { max: n });
        if (!provider) notes.push(`Web search gave nothing${error ? ` (${error})` : ""}.`);
        return results.map<ScoredChunk>((r, i) => ({
          id: `web:${r.url}`,
          docId: r.url,
          docName: r.title || r.url,
          docSource: r.url,
          text: r.snippet || r.title,
          score: 1 - i * 0.05,
          source: "web",
        }));
      });
    }

    if (request.body?.graph) {
      retrievers.set("knowledge_graph", async (q, n) => {
        const { nodes, edges } = await searchGraph(getKGStore(), q, n);
        const name = new Map(nodes.map((x) => [x.id, x.name]));
        return nodes.map<ScoredChunk>((node, i) => {
          // A model spells one predicate several ways ("part of", "part_of"); say each fact once.
          const facts = [
            ...new Set(
              edges
                .filter((e) => e.subjectId === node.id)
                .map(
                  (e) =>
                    `${node.name} ${e.predicate.replace(/_/g, " ")} ${name.get(e.objectId) ?? e.objectId}`,
                ),
            ),
          ];
          return {
            id: `kg:${node.id}`,
            docId: `graph/${node.id}`,
            docName: `${node.name} (${node.type})`,
            text: facts.length ? facts.join(". ") : `${node.name} is a ${node.type.toLowerCase()}.`,
            score: 1 - i * 0.05,
            source: "knowledge_graph",
          };
        });
      });
    }

    if (retrievers.size === 0) {
      notes.push("Nothing to search: add a knowledge base, or turn on the web or the graph.");
    }
    // Scores from different sources do not compare, so take each source's best hit first, then
    // each one's second best, and so on.
    const lists = await Promise.all(
      [...retrievers.values()].map((fn) => fn(query, limit).catch(() => [] as ScoredChunk[])),
    );
    const seen = new Set<string>();
    const ranked = lists
      .flatMap((list) =>
        list
          .sort((a, b) => b.score - a.score)
          .map((chunk, rank) => ({ chunk, rank }))
          .filter(({ chunk }) => !seen.has(chunk.id) && !!seen.add(chunk.id)),
      )
      .sort((a, b) => a.rank - b.rank)
      .map(({ chunk }) => chunk);
    const set = numberSources(ranked);

    let answer: string | undefined;
    let answerError: string | undefined;
    if (request.body?.answer && set.chunks.length) {
      const screened = await screenForPrompt(set.chunks.map((c) => c.text));
      set.chunks.forEach((c, i) => (c.text = screened[i]!));
      try {
        answer = await deps.llm(
          [
            { role: "system", content: ANSWER_PROMPT },
            { role: "user", content: `${sourcesPrompt(set)}\n\nQuestion: ${query}` },
          ],
          700,
        );
      } catch (err) {
        answerError = err instanceof Error ? err.message : String(err);
      }
    }
    const cited = answer ? [...citedNumbers(answer, set.sources.length)] : [];

    return reply.send({
      query,
      results: set.chunks.slice(0, limit * Math.max(1, retrievers.size)).map((c) => {
        const meta = c.metadata as { kbId?: string; kbName?: string } | undefined;
        return {
          n: set.numberOf.get(c.id),
          title: c.docName || c.docId,
          url: c.docSource?.startsWith("http") ? c.docSource : undefined,
          source: c.source,
          kbId: meta?.kbId,
          kbName: meta?.kbName,
          text: c.text.slice(0, 1_200),
          score: c.score,
        };
      }),
      sources: set.sources,
      ...(answer !== undefined ? { answer, cited } : {}),
      ...(answerError ? { answerError } : {}),
      notes,
    });
  });
}
