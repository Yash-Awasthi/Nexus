// SPDX-License-Identifier: Apache-2.0
/**
 * GraphRAG local search (entity-anchored retrieval) — row 98 dual-mode parity.
 *
 * `GraphRAGQueryEngine` implements Microsoft GraphRAG's GLOBAL search variant:
 * map-reduce over hierarchical community reports. GraphRAG's LOCAL search is a
 * different, data-driven mechanic: anchor on query-matched ENTITIES, expand
 * through the graph to their neighbors, assemble a single context window from
 * entity + relationship tables (plus linked community reports), and answer in
 * one pass — no map-reduce.
 *
 * Semantics ported from graphrag/packages/.../context_builder/local_context.py:
 *   • entity table rows carry a rank column ("number of relationships", i.e.
 *     graph degree), built from the relation list;
 *   • relationship filtering is two-tier: in-network relationships (both ends
 *     among the selected entities) come first; out-of-network relationships
 *     (exactly one end selected) follow, sorted by how many selected entities
 *     the outer endpoint links to (mutual-link priority), then by rank, capped
 *     at `topKRelationships × |selected|`;
 *   • every table is truncated by a token budget (`maxContextTokens`), row by
 *     row in rank order;
 *   • one final LLM completion over the assembled tables.
 *
 * Honest divergences (noted, not silently dropped): query→entity mapping here
 * is lexical (name/token overlap with mention tiebreaks) — GraphRAG's embedding
 * and LLM entity mapping are external-model machinery; source-text units,
 * covariates, conversation history, and rate/relevancy scoring are out of
 * scope. The engine consumes the indexer's own shapes (IndexedEntity /
 * IndexedRelation) plus optional CommunityReports, so index → local-search is a
 * direct pipeline with no new store dependency.
 */

import type { QueryRouter, CommunityReport } from "./index.js";
import type { IndexedEntity, IndexedRelation } from "./index-graphrag.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalSearchResult {
  answer: string;
  /** Selected + expanded entity names that anchored the search. */
  entitiesUsed: string[];
  /** Source/target pairs surfaced in the relationship table. */
  relationshipsUsed: Array<{ source: string; target: string; type: string }>;
  /** Community reports whose entities intersect the selected set. */
  reportsUsed: CommunityReport[];
  /** The assembled context text sent to the model. */
  context: string;
  durationMs: number;
}

export interface LocalSearchOptions {
  /** Max selected entities before neighbor expansion. Default 10. */
  maxEntities?: number;
  /** Graph neighbor levels to expand past the selected set. Default 1. */
  levels?: number;
  /** Token budget for the assembled context. Default 8000. */
  maxContextTokens?: number;
  /** Per-selected-entity relationship budget (× |selected| = cap). Default 10. */
  topKRelationships?: number;
  /** Attach linked community reports to the context. Default true. */
  includeReports?: boolean;
}

function tokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class LocalSearchEngine {
  private readonly entities: IndexedEntity[];
  private readonly relations: IndexedRelation[];
  private readonly degree = new Map<string, number>();
  private readonly reports: CommunityReport[];

  constructor(
    entities: IndexedEntity[],
    relations: IndexedRelation[],
    private readonly router: QueryRouter,
    private readonly modelAlias: string,
    reports: CommunityReport[] = [],
  ) {
    this.entities = entities;
    this.relations = relations;
    this.reports = reports;
    for (const rel of relations) {
      this.degree.set(rel.source, (this.degree.get(rel.source) ?? 0) + 1);
      this.degree.set(rel.target, (this.degree.get(rel.target) ?? 0) + 1);
    }
  }

  private entityByName(name: string): IndexedEntity | undefined {
    return this.entities.find((e) => e.name === name);
  }

  /** Lexical query→entity mapping (rank = token overlap, then mentions). */
  private mapQueryToEntities(query: string, max: number): IndexedEntity[] {
    const queryTokens = new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 1));
    const scored = this.entities.map((entity) => {
      const name = entity.name.toLowerCase();
      const nameTokens = name.split(/\s+/);
      let overlap = 0;
      for (const t of queryTokens) {
        if (name.includes(t) || nameTokens.some((nt) => nt.startsWith(t) || t.startsWith(nt))) overlap++;
      }
      const descHit = entity.descriptions.some((d) => queryTokens.has(d.toLowerCase()));
      return { entity, overlap: overlap + (descHit ? 0.5 : 0) };
    });
    return scored
      .filter((s) => s.overlap > 0)
      .sort(
        (a, b) =>
          b.overlap - a.overlap ||
          b.entity.mentions - a.entity.mentions ||
          (this.degree.get(b.entity.name) ?? 0) - (this.degree.get(a.entity.name) ?? 0),
      )
      .slice(0, max)
      .map((s) => s.entity);
  }

  /** Neighbor expansion: entities reachable within `levels` hops of the set. */
  private expandNeighbors(selected: IndexedEntity[], levels: number): IndexedEntity[] {
    const names = new Set(selected.map((e) => e.name));
    const frontier = new Set(selected.map((e) => e.name));
    const result = [...selected];
    const seen = new Set(names);
    for (let hop = 0; hop < levels; hop++) {
      const next = new Set<string>();
      for (const rel of this.relations) {
        if (frontier.has(rel.source) && !seen.has(rel.target)) next.add(rel.target);
        if (frontier.has(rel.target) && !seen.has(rel.source)) next.add(rel.source);
      }
      for (const n of next) seen.add(n);
      frontier.clear();
      for (const n of next) {
        const entity = this.entityByName(n);
        if (entity && !names.has(n)) {
          result.push(entity);
          names.add(n);
          frontier.add(n);
        }
      }
    }
    return result;
  }

  /** graphrag _filter_relationships: in-network first, then mutual-link ranked. */
  private filterRelationships(
    selected: IndexedEntity[],
    topK: number,
  ): IndexedRelation[] {
    const selectedNames = new Set(selected.map((e) => e.name));
    const inNetwork: IndexedRelation[] = [];
    const outNetwork: IndexedRelation[] = [];
    for (const rel of this.relations) {
      const sIn = selectedNames.has(rel.source);
      const tIn = selectedNames.has(rel.target);
      if (sIn && tIn) inNetwork.push(rel);
      else if (sIn || tIn) outNetwork.push(rel);
    }

    // mutual-link priority: how many selected entities the outer endpoint links to
    const linkCount = new Map<string, number>();
    for (const rel of outNetwork) {
      const outer = selectedNames.has(rel.source) ? rel.target : rel.source;
      linkCount.set(outer, (linkCount.get(outer) ?? 0) + 1);
    }
    outNetwork.sort(
      (a, b) =>
        (linkCount.get(selectedNames.has(b.source) ? b.target : b.source) ?? 0) -
          (linkCount.get(selectedNames.has(a.source) ? a.target : a.source) ?? 0) ||
        (this.degree.get(b.source) ?? 0) + (this.degree.get(b.target) ?? 0) -
          ((this.degree.get(a.source) ?? 0) + (this.degree.get(a.target) ?? 0)),
    );

    const budget = topK * selected.length;
    return [...inNetwork, ...outNetwork.slice(0, budget)];
  }

  private buildEntityTable(entities: IndexedEntity[], budget: number): { text: string; names: string[] } {
    const lines: string[] = [];
    const names: string[] = [];
    const header = "-----Entities-----\nid|entity|description|number of relationships";
    let tokens = tokenCount(header);
    lines.push(header);
    for (const entity of entities) {
      const desc = entity.descriptions.join("; ") || "";
      const row = `${entity.name}|${entity.type}|${desc}|${this.degree.get(entity.name) ?? 0}`;
      const rowTokens = tokenCount(row);
      if (tokens + rowTokens > budget) break;
      lines.push(row);
      names.push(entity.name);
      tokens += rowTokens;
    }
    return { text: lines.join("\n"), names };
  }

  private buildRelationshipTable(
    relations: IndexedRelation[],
    budget: number,
  ): { text: string; used: Array<{ source: string; target: string; type: string }> } {
    const header = "-----Relationships-----\nsource|target|description|number of relationships";
    const lines = [header];
    const used: Array<{ source: string; target: string; type: string }> = [];
    let tokens = tokenCount(header);
    for (const rel of relations) {
      const desc = rel.descriptions.join("; ") || "";
      const row = `${rel.source}|${rel.target}|${desc}|${rel.type}`;
      const rowTokens = tokenCount(row);
      if (tokens + rowTokens > budget) break;
      lines.push(row);
      used.push({ source: rel.source, target: rel.target, type: rel.type });
      tokens += rowTokens;
    }
    return { text: lines.join("\n"), used };
  }

  private linkedReports(names: Set<string>): CommunityReport[] {
    return this.reports.filter((r) => r.entities.some((e) => names.has(e)));
  }

  async search(question: string, options: LocalSearchOptions = {}): Promise<LocalSearchResult> {
    const start = Date.now();
    const maxEntities = options.maxEntities ?? 10;
    const levels = options.levels ?? 1;
    const maxContextTokens = options.maxContextTokens ?? 8000;
    const topKRelationships = options.topKRelationships ?? 10;

    // 1. Anchor on query-matched entities, then expand through the graph.
    const selected = this.mapQueryToEntities(question, maxEntities);
    if (selected.length === 0) {
      const empty = "No entities in the knowledge graph matched the question.";
      return {
        answer: empty,
        entitiesUsed: [],
        relationshipsUsed: [],
        reportsUsed: [],
        context: empty,
        durationMs: Date.now() - start,
      };
    }
    const expanded = this.expandNeighbors(selected, levels);
    const selectedNames = new Set(selected.map((e) => e.name));

    // 2. Relationship table (graphrag two-tier filter) and report attachment.
    const rels = this.filterRelationships(selected, topKRelationships);
    const reportsUsed = options.includeReports === false ? [] : this.linkedReports(selectedNames);

    // 3. Assemble one budgeted context window (tables share the budget).
    const tableBudget = Math.max(400, Math.floor((maxContextTokens * 0.9) / 2));
    const entityTable = this.buildEntityTable(expanded, tableBudget);
    const relTable = this.buildRelationshipTable(rels, tableBudget);
    const reportBlock = reportsUsed.length
      ? `\n-----Reports-----\n${reportsUsed
          .map((r) => `[${r.title}] ${r.summary}`)
          .join("\n")}`
      : "";
    const context =
      `${entityTable.text}\n\n${relTable.text}${reportBlock}\n\n-----Question-----\n${question}`;

    // 4. Single-pass synthesis (no map-reduce — the local-search signature).
    const prompt = [
      "You are an AI assistant helping answer questions using graph context.",
      "Answer the question using the entities, relationships, and reports provided.",
      "If the context is insufficient, say so explicitly.",
      "",
      context,
    ].join("\n");
    const resp = await this.router.complete({
      model: this.modelAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
    });

    return {
      answer: resp.content,
      entitiesUsed: entityTable.names,
      relationshipsUsed: relTable.used,
      reportsUsed,
      context,
      durationMs: Date.now() - start,
    };
  }
}
