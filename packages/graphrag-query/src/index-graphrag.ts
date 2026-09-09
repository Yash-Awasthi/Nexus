// SPDX-License-Identifier: Apache-2.0
/**
 * GraphRAG indexing pipeline — builds the community reports that
 * {@link GraphRAGQueryEngine} queries (Microsoft-GraphRAG-style).
 *
 * @nexus/graphrag-query previously only *consumed* pre-built community
 * reports; nothing turned documents into them. This module closes the loop for
 * the GraphRAG-family repos in the absorption ledger (graphrag, lightrag,
 * nano-graphrag, …):
 *
 *   1. extract   — per chunk, an injectable entity extractor (+ optional
 *                  relation extractor) yields typed entities/relationships.
 *   2. merge     — entities dedupe by normalized name; relations dedupe by
 *                  (source|type|target). Mentions accumulate across chunks.
 *   3. partition — communities are connected components of the entity graph
 *                  (level 0, the same starting level GraphRAG reports use).
 *   4. summarize — each community is summarized into a CommunityReport via an
 *                  injectable summarizer or a QueryRouter (JSON prompt), ready
 *                  for GraphRAGQueryEngine.addReports().
 *
 * No external dependencies: extractors/summarizers are injected, so the
 * pipeline is deterministic and testable without a live model.
 */

import type { CommunityReport } from "./index.js";

// ── Extraction types ──────────────────────────────────────────────────────────

export interface EntityExtraction {
  name: string;
  type: string;
  description?: string;
}

export interface RelationExtraction {
  source: string;
  target: string;
  type: string;
  description?: string;
}

// ── Indexed output types ──────────────────────────────────────────────────────

export interface IndexedEntity {
  name: string;
  type: string;
  descriptions: string[];
  /** Number of chunks that mentioned this entity. */
  mentions: number;
}

export interface IndexedRelation {
  source: string;
  target: string;
  type: string;
  descriptions: string[];
  mentions: number;
}

export interface CommunityInput {
  id: string;
  entities: IndexedEntity[];
  relations: IndexedRelation[];
}

// ── Summarizer ────────────────────────────────────────────────────────────────

export interface CommunityReportSummary {
  title: string;
  summary: string;
  findings: string[];
}

/** Minimal LLM router surface (structural subset of GraphRAGQueryEngine's). */
export interface IndexRouter {
  complete(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

/**
 * Summarize a community into a CommunityReport using an LLM router. The router
 * is prompted for strict JSON {title, summary, findings[]}; parsing is
 * tolerant — any non-JSON response becomes the summary with no findings.
 */
export async function makeCommunitySummarizer(
  router: IndexRouter,
  modelAlias: string,
): Promise<(community: CommunityInput) => Promise<CommunityReportSummary>> {
  return async (community) => {
    const names = community.entities.map((e) => e.name);
    const facts = [
      ...community.entities.map(
        (e) => `${e.name} (${e.type}): ${(e.descriptions[0] ?? "no description").slice(0, 200)}`,
      ),
      ...community.relations.map(
        (r) =>
          `${r.source} -[${r.type}]-> ${r.target}${r.descriptions[0] ? `: ${r.descriptions[0].slice(0, 200)}` : ""}`,
      ),
    ];
    const prompt = [
      `You are building a GraphRAG community report for the following entities and relationships.`,
      `Return STRICT JSON only: {"title": string, "summary": string, "findings": string[]}`,
      ``,
      `Entities: ${names.join(", ")}`,
      `Facts:`,
      ...facts.map((f) => `- ${f}`),
    ].join("\n");

    const resp = await router.complete({
      model: modelAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
    });
    return (
      parseSummaryJson(resp.content) ?? {
        title: names.slice(0, 8).join(", ") || "empty community",
        summary: resp.content,
        findings: [],
      }
    );
  };
}

/** Tolerant {title,summary,findings} extraction from an LLM response. */
export function parseSummaryJson(content: string): CommunityReportSummary | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as Partial<CommunityReportSummary>;
    if (typeof raw.title !== "string" || typeof raw.summary !== "string") return null;
    return {
      title: raw.title,
      summary: raw.summary,
      findings: Array.isArray(raw.findings) ? raw.findings.map(String) : [],
    };
  } catch {
    return null;
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface GraphRagIndexOptions {
  /** Entity extractor: chunk -> entities. Required. */
  extractEntities: (chunk: string) => EntityExtraction[] | Promise<EntityExtraction[]>;
  /** Relation extractor: (chunk, entities) -> relations. Optional (default: none). */
  extractRelations?: (
    chunk: string,
    entities: EntityExtraction[],
  ) => RelationExtraction[] | Promise<RelationExtraction[]>;
  /** Community summarizer. Optional if `router`+`modelAlias` are given. */
  summarizer?: (community: CommunityInput) => Promise<CommunityReportSummary>;
  /** Router used with {@link makeCommunitySummarizer} when `summarizer` is absent. */
  router?: IndexRouter;
  /** Model alias passed to the router prompt. */
  modelAlias?: string;
}

export interface GraphRagIndexResult {
  /** Level-0 community reports, ready for GraphRAGQueryEngine.addReports(). */
  reports: CommunityReport[];
  entities: IndexedEntity[];
  relations: IndexedRelation[];
  /** Community groupings (id + member entity names), for inspection. */
  communities: { id: string; entityNames: string[] }[];
}

const normalize = (s: string): string => s.trim().toLowerCase();
const CAP = 12; // community titles summarize up to 12 entity names

/**
 * Build a GraphRAG index from document chunks: extract -> merge -> partition
 * into connected components -> summarize into level-0 community reports.
 */
export async function buildGraphRagIndex(
  chunks: string[],
  opts: GraphRagIndexOptions,
): Promise<GraphRagIndexResult> {
  const summarizer =
    opts.summarizer ??
    (opts.router
      ? await makeCommunitySummarizer(opts.router, opts.modelAlias ?? "graphrag")
      : null);
  if (!summarizer) {
    throw new Error("buildGraphRagIndex needs opts.summarizer or opts.router");
  }
  const extractRelations = opts.extractRelations ?? (() => []);

  // 1-2. Extract + merge entities.
  const entityByKey = new Map<string, IndexedEntity>();
  const relationByKey = new Map<string, IndexedRelation>();

  for (const chunk of chunks) {
    const entities = await opts.extractEntities(chunk);
    for (const e of entities) {
      const key = normalize(e.name);
      if (!key) continue;
      const existing = entityByKey.get(key);
      if (existing) {
        existing.mentions += 1;
        if (e.description && !existing.descriptions.includes(e.description)) {
          existing.descriptions.push(e.description);
        }
      } else {
        entityByKey.set(key, {
          name: e.name,
          type: e.type,
          descriptions: e.description ? [e.description] : [],
          mentions: 1,
        });
      }
    }

    const relations = await extractRelations(chunk, entities);
    for (const r of relations) {
      const sKey = normalize(r.source);
      const tKey = normalize(r.target);
      if (!sKey || !tKey) continue;
      const key = `${sKey}|${normalize(r.type)}|${tKey}`;
      const existing = relationByKey.get(key);
      if (existing) {
        existing.mentions += 1;
        if (r.description && !existing.descriptions.includes(r.description)) {
          existing.descriptions.push(r.description);
        }
      } else {
        relationByKey.set(key, {
          source: r.source,
          target: r.target,
          type: r.type,
          descriptions: r.description ? [r.description] : [],
          mentions: 1,
        });
      }
    }
  }

  const entities = [...entityByKey.values()];
  const relations = [...relationByKey.values()];

  // 3. Partition into connected components of the entity graph.
  const byName = new Map(entities.map((e) => [normalize(e.name), e]));
  const adjacency = new Map<string, Set<string>>();
  for (const r of relations) {
    const s = normalize(r.source);
    const t = normalize(r.target);
    if (!adjacency.has(s)) adjacency.set(s, new Set());
    if (!adjacency.has(t)) adjacency.set(t, new Set());
    adjacency.get(s)!.add(t);
    adjacency.get(t)!.add(s);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const entity of entities) {
    const key = normalize(entity.name);
    if (visited.has(key)) continue;
    // BFS from this entity (entities with no edges form singleton communities).
    const queue = [key];
    const member: string[] = [];
    visited.add(key);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      member.push(cur);
      for (const next of adjacency.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    components.push(member);
  }

  // 4. Summarize each component into a level-0 CommunityReport.
  const communities: GraphRagIndexResult["communities"] = [];
  const reports: CommunityReport[] = [];
  for (let i = 0; i < components.length; i++) {
    const memberKeys = components[i]!.sort();
    const communityEntities = memberKeys
      .map((k) => byName.get(k)!)
      .filter((e): e is IndexedEntity => e !== undefined);
    const memberSet = new Set(memberKeys);
    const communityRelations = relations.filter(
      (r) => memberSet.has(normalize(r.source)) && memberSet.has(normalize(r.target)),
    );
    const id = `community-${i}`;
    communities.push({ id, entityNames: communityEntities.map((e) => e.name) });

    const summary = await summarizer({
      id,
      entities: communityEntities,
      relations: communityRelations,
    });
    reports.push({
      id,
      communityId: id,
      level: 0,
      title: summary.title,
      summary: summary.summary,
      fullContent: communityEntities
        .map((e) => e.name)
        .slice(0, CAP)
        .join(", "),
      rank: communityEntities.length,
      rating: 0,
      findings: summary.findings,
      entities: communityEntities.map((e) => e.name),
      createdAt: Date.now(),
    });
  }

  return { reports, entities, relations, communities };
}

// ── Graph merge operations (LightRAG parity, pass 55) ─────────────────────────
//
// `buildGraphRagIndex` dedupes entities by NORMALIZED NAME at build time, but
// has no operation for merging two *distinct* nodes once an external signal
// (an LLM or the caller) decides they are the same real-world thing. LightRAG's
// merge ops (utils_graph._merge_entities_impl) are deterministic graph surgery
// on top of that decision:
//
//   • source nodes' descriptions join onto the target (concatenate | keep_first),
//     mentions combine (sum | max), type keep_first;
//   • every relation touching a source is REWIRED to the target;
//   • redirected relations that collapse onto an existing same-typed edge merge:
//     descriptions join unique, mentions take the max (LightRAG: weight =
//     max(input weights, distinct merged evidence sources));
//   • relations whose two endpoints both merge into the target become self-loops
//     and are dropped.
//
// The merge DECISION (which sources → which target, optionally LLM-made) stays
// with the caller; these are the operations that apply it. Inputs are not
// mutated — a new entity/relation set is returned.

export interface MergeGraphOptions {
  /** How source descriptions combine onto the target. Default "concatenate". */
  descriptionStrategy?: "concatenate" | "keep_first";
  /** How mentions combine. Default "sum". */
  mentionsStrategy?: "sum" | "max";
}

export interface MergedGraph {
  entities: IndexedEntity[];
  relations: IndexedRelation[];
}

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * Merge the named source entities into `targetName`, rewiring the graph.
 * Mirrors LightRAG's deterministic merge graph-ops (see module note).
 */
export function mergeGraphEntities(
  entities: IndexedEntity[],
  relations: IndexedRelation[],
  sourceNames: string[],
  targetName: string,
  opts: MergeGraphOptions = {},
): MergedGraph {
  const { descriptionStrategy = "concatenate", mentionsStrategy = "sum" } = opts;
  const entityByKey = new Map(entities.map((e) => [normalize(e.name), e]));

  const tKey = normalize(targetName);
  if (!tKey) throw new Error(`Invalid target entity name '${targetName}'`);
  const sourceKeys = new Set<string>();
  for (const s of sourceNames) {
    const k = normalize(s);
    if (!entityByKey.has(k)) throw new Error(`Source entity '${s}' does not exist`);
    if (k === tKey) throw new Error(`Source entity '${s}' cannot be merged into itself`);
    sourceKeys.add(k);
  }
  if (sourceKeys.size === 0) return { entities: [...entities], relations: [...relations] };

  const targetEntity = entityByKey.get(tKey);
  const sourceEntities = [...sourceKeys].map((k) => entityByKey.get(k)!);
  const mergedName = targetName.trim();

  // ── merged entity: descriptions per strategy, type keep_first, mentions ────
  const mergedDescriptions =
    descriptionStrategy === "concatenate"
      ? unique([
          ...(targetEntity?.descriptions ?? []),
          ...sourceEntities.flatMap((e) => e.descriptions),
        ])
      : targetEntity?.descriptions.length
        ? targetEntity.descriptions
        : (sourceEntities[0]?.descriptions ?? []);
  const mentionTotal =
    (targetEntity?.mentions ?? 0) + sourceEntities.reduce((s, e) => s + e.mentions, 0);
  const mergedEntity: IndexedEntity = {
    name: mergedName,
    type: targetEntity ? targetEntity.type : (sourceEntities[0]!.type ?? "entity"),
    descriptions: mergedDescriptions,
    mentions:
      mentionsStrategy === "sum"
        ? mentionTotal
        : Math.max(targetEntity?.mentions ?? 0, ...sourceEntities.map((e) => e.mentions)),
  };

  // ── entity list: drop sources, replace-or-append the target ───────────────
  const outEntities: IndexedEntity[] = [];
  let targetPlaced = false;
  for (const e of entities) {
    const k = normalize(e.name);
    if (sourceKeys.has(k)) continue;
    if (k === tKey) {
      outEntities.push(mergedEntity);
      targetPlaced = true;
    } else {
      outEntities.push(e);
    }
  }
  if (!targetPlaced) outEntities.push(mergedEntity);

  // ── relations: rewire endpoints off sources, collapse duplicates ───────────
  const collapsed = new Map<string, IndexedRelation>();
  const resultRelations: IndexedRelation[] = [];
  for (const r of relations) {
    const sKey = normalize(r.source);
    const tKey2 = normalize(r.target);
    const sMerged = sourceKeys.has(sKey);
    const tMerged = sourceKeys.has(tKey2);
    const newSource = sMerged ? mergedName : r.source;
    const newTarget = tMerged ? mergedName : r.target;
    // both ends merged (or one end merged onto the already-target end) → self-loop
    if (normalize(newSource) === normalize(newTarget)) continue;
    const key = `${normalize(newSource)}|${normalize(r.type)}|${normalize(newTarget)}`;
    const existing = collapsed.get(key);
    if (existing) {
      // redirected relation collapsed onto an existing same-typed edge
      existing.descriptions = unique([...existing.descriptions, ...r.descriptions]);
      existing.mentions = Math.max(existing.mentions, r.mentions); // LightRAG weight=max semantics
      continue;
    }
    const rel: IndexedRelation = {
      source: newSource,
      target: newTarget,
      type: r.type,
      descriptions: [...r.descriptions],
      mentions: r.mentions,
    };
    collapsed.set(key, rel);
    resultRelations.push(rel);
  }

  return { entities: outEntities, relations: resultRelations };
}
