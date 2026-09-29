// SPDX-License-Identifier: Apache-2.0
/**
 * Numbered sources for a council answer: the @kb and @web context a question
 * names, retrieved in parallel, numbered once per document, cited inline as
 * [n], and listed under the verdict.
 */
import {
  insertCitations,
  multiSourceRetrieve,
  type RetrievalSource,
  type ScoredChunk,
  type SourceRetrieverFn,
} from "@nexus/retrieval";
import { UNTRUSTED_NOTE, screenUntrusted } from "@nexus/shared";

export interface CitedSource {
  n: number;
  title: string;
  url?: string;
}

export interface SourceSet {
  sources: CitedSource[];
  chunks: ScoredChunk[];
  /** Chunk id → the number of the document it came from. */
  numberOf: Map<string, number>;
}

const EXCERPT_CHARS = 2_000;

/** Retrieve every source at once and number each distinct document by first appearance. */
export async function gatherSources(
  query: string,
  retrievers: Map<RetrievalSource, SourceRetrieverFn>,
  limit = 5,
): Promise<SourceSet> {
  return numberSources(retrievers.size ? await multiSourceRetrieve(query, retrievers, limit) : []);
}

/** Number each distinct document of `chunks` by first appearance. */
export function numberSources(chunks: ScoredChunk[]): SourceSet {
  const sources: CitedSource[] = [];
  const byDoc = new Map<string, number>();
  const numberOf = new Map<string, number>();
  for (const c of chunks) {
    const key = c.docSource ?? c.docName ?? c.docId;
    let n = byDoc.get(key);
    if (n === undefined) {
      n = sources.length + 1;
      byDoc.set(key, n);
      sources.push({
        n,
        title: c.docName || c.docSource || c.docId,
        ...(c.docSource?.startsWith("http") ? { url: c.docSource } : {}),
      });
    }
    numberOf.set(c.id, n);
  }
  return { sources, chunks, numberOf };
}

/** The block every member reads: each source's excerpts under its number, and how to cite. */
export function sourcesPrompt(set: SourceSet): string {
  if (!set.sources.length) return "";
  const blocks = set.sources.map((s) => {
    const excerpts = set.chunks
      .filter((c) => set.numberOf.get(c.id) === s.n)
      .map((c) => screenUntrusted(c.text.slice(0, EXCERPT_CHARS)).text)
      .join("\n\n");
    return `[${s.n}] ${s.title}${s.url ? ` (${s.url})` : ""}\n${excerpts}`;
  });
  return (
    "Sources for this question. Where your answer relies on one, cite it inline as [n], " +
    `for example [1]. Do not cite a source for anything it does not say. ${UNTRUSTED_NOTE}\n\n${blocks.join("\n\n")}`
  );
}

/** The source numbers an answer cites inline, limited to ones that exist. */
export function citedNumbers(text: string, count: number): Set<number> {
  const found = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= count) found.add(n);
  }
  return found;
}

/** For an answer that cites nothing, the sources whose excerpts its sentences match. */
export async function supportingNumbers(
  answer: string,
  set: SourceSet,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<Set<number>> {
  if (!answer.trim() || !set.chunks.length) return new Set();
  const chunkVectors = await embed(set.chunks.map((c) => c.text)).catch(() => []);
  const { citedChunkIds } = await insertCitations(answer, set.chunks, chunkVectors, embed);
  return new Set([...citedChunkIds].map((id) => set.numberOf.get(id)!).filter(Boolean));
}

/** Markdown closing the verdict: the cited sources, or every source when none was cited. */
export function sourcesFooter(set: SourceSet, cited: Set<number>): string {
  if (!set.sources.length) return "";
  const shown = cited.size ? set.sources.filter((s) => cited.has(s.n)) : set.sources;
  // A list with the bare URL: the chat renders a Markdown subset without links.
  const lines = shown.map(
    (s) => `- [${s.n}] ${s.title}${s.url && s.url !== s.title ? ` — ${s.url}` : ""}`,
  );
  return `\n\n**${cited.size ? "Sources" : "Sources consulted"}**\n\n${lines.join("\n")}`;
}
