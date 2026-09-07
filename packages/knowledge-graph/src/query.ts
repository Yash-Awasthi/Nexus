// SPDX-License-Identifier: Apache-2.0
/**
 * Cypher-subset query engine for @nexus/knowledge-graph.
 *
 * The graph-DB semantics the stores/traversal layer lacks: a tiny, honest
 * Cypher subset you can run against any {@link KGStore} — the InMemory
 * store, the Neon store, or a future engine — without learning a new API.
 *
 * Supported grammar (keywords, labels and predicates case-insensitive):
 *
 *   MATCH (a:LABEL)                       — node scan (WHERE can filter it)
 *   MATCH (a:LABEL)-[:PRED]->(b[:LABEL])  — single directed hop; `-[:PRED]`
 *                                          omitted entirely for any predicate
 *   [WHERE a.prop = 'value' | a.prop > 5 | b.type = 'PERSON' | a.name CONTAINS 'x']
 *                                          — AND-joined; =, <, >, <=, >=, CONTAINS
 *   [RETURN a, b.name AS title]            — bare var, or var.field with optional alias
 *   [LIMIT n]
 *
 * Anything outside this subset raises {@link KGError} with code QUERY_SYNTAX —
 * deliberately a subset, not a pretending parser. `var.type` resolves against
 * the node's EntityType; other fields resolve against node.properties first,
 * then the node's scalar fields (name/confidence).
 *
 * Result shape is a table, like the Neo4j driver: `{ columns, rows }` with
 * rows as objects keyed by alias (defaults to the expression text).
 */

import { KGError, type KGNode, type KGStore } from "./index.js";

// ── Parsed query ─────────────────────────────────────────────────────────────

export interface PatternStep {
  /** Variable bound to the subject node, e.g. "a". */
  subject: string;
  /** Subject label (node.type), uppercased; undefined = any type. */
  subjectLabel?: string;
  /** Edge predicate, uppercased; undefined = any predicate. */
  predicate?: string;
  /** Variable bound to the object node; undefined when MATCH has no hop. */
  object?: string;
  /** Object label (node.type), uppercased; undefined = any type. */
  objectLabel?: string;
}

export interface WhereCondition {
  variable: string;
  field: string;
  operator: "=" | "<" | ">" | "<=" | ">=" | "CONTAINS";
  value: string | number;
}

export interface Projection {
  variable: string;
  field?: string;
  alias: string;
}

export interface CypherQuery {
  step: PatternStep;
  where: WhereCondition[];
  projections: Projection[] | undefined;
  limit: number | undefined;
}

export interface CypherResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

// ── Parser ───────────────────────────────────────────────────────────────────

// Node pattern: (a) or (a:LABEL).
const NODE_RE = /\(\s*([a-zA-Z]\w*)\s*(?::\s*([A-Za-z]+)\s*)?\)/;
// Full pattern: NODE_RE then an optional hop `-[PRED]->`/`-[:PRED]->` then NODE_RE.
const MATCH_RE = new RegExp(
  `^MATCH\\s+${NODE_RE.source}\\s*(?:-\\s*\\[\\s*(?::)?([A-Za-z_]+)?\\s*\\]\\s*->\\s*${NODE_RE.source})?`,
  "i",
);
const COND_RE = /^([a-zA-Z]\w*)\.([a-zA-Z]\w*)\s*(=|<=|>=|<|>|CONTAINS)\s*(.+)$/i;
const PROJ_RE = /^([a-zA-Z]\w*)(?:\.([a-zA-Z]\w*))?(?:\s+AS\s+([a-zA-Z]\w*))?$/i;

function parseValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  const num = Number(trimmed);
  return Number.isNaN(num) ? trimmed : num;
}

/** Parse the supported Cypher subset. Throws KGError(QUERY_SYNTAX) otherwise. */
export function parseCypher(query: string): CypherQuery {
  const q = query.trim().replace(/\s+/g, " ").replace(/;\s*$/, "");
  const match = MATCH_RE.exec(q);
  if (!match) {
    throw new KGError(
      "Expected MATCH (a) or MATCH (a:LABEL)-[:PRED]->(b) — the supported subset is a node scan or a single directed hop",
      "QUERY_SYNTAX",
    );
  }
  // Groups: subject, subjectLabel, [predicate, object, objectLabel] when a hop is present.
  const subject = match[1]!;
  const subjectLabel = match[2]?.toUpperCase();
  const predicate = match[3]?.toUpperCase();
  const object = match[4];
  const objectLabel = match[5]?.toUpperCase();

  // LIMIT must appear at the end.
  const limit = /LIMIT\s+(\d+)\s*$/i.exec(q)?.[1];
  let rest = q.slice(match[0].length).trim();
  if (limit !== undefined) {
    rest = rest.replace(/LIMIT\s+\d+\s*$/i, "").trim();
  }

  // RETURN is stripped first so WHERE value regexes never swallow it.
  const retIdx = rest.search(/\bRETURN\s+/i);
  const whereText = retIdx >= 0 ? rest.slice(0, retIdx).trim() : rest;
  const returnText = retIdx >= 0 ? rest.slice(retIdx).replace(/^\s*RETURN\s+/i, "") : undefined;

  const where: WhereCondition[] = [];
  if (whereText.length > 0) {
    const whereMatch = /^WHERE\s+(.+)$/i.exec(whereText);
    if (!whereMatch) {
      throw new KGError(
        `Unsupported trailing clause after pattern: "${whereText}" (supported: WHERE, RETURN, LIMIT)`,
        "QUERY_SYNTAX",
      );
    }
    for (const condText of whereMatch[1]!.split(/\s+AND\s+/i)) {
      const cond = COND_RE.exec(condText);
      if (!cond) {
        throw new KGError(
          `Unsupported WHERE clause: "${condText}" (supported: var.field = 'v' | < | > | <= | >= | CONTAINS 'v', AND-joined)`,
          "QUERY_SYNTAX",
        );
      }
      const [, variable, field, operator, rawValue] = cond as unknown as [
        string,
        string,
        string,
        WhereCondition["operator"],
        string,
      ];
      where.push({ variable, field, operator: operator.toUpperCase() as WhereCondition["operator"], value: parseValue(rawValue) });
    }
  }

  let projections: Projection[] | undefined;
  if (returnText !== undefined) {
    const ret = returnText.trim();
    projections = ret.split(",").map((part) => {
      const proj = PROJ_RE.exec(part.trim());
      if (!proj) {
        throw new KGError(`Unsupported RETURN projection: "${part.trim()}" (supported: var or var.field, optional AS alias)`, "QUERY_SYNTAX");
      }
      const [, variable, field, alias] = proj as unknown as [string, string, string | undefined, string | undefined];
      return {
        variable,
        field,
        alias: alias ?? (field ? `${variable}.${field}` : variable),
      };
    });
  }

  return {
    step: {
      subject,
      subjectLabel,
      predicate,
      object,
      objectLabel,
    },
    where,
    projections,
    limit: limit !== undefined ? Number(limit) : undefined,
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Resolve var.field against a node: properties first, then scalar fields. */
export function fieldOf(node: KGNode, field: string): unknown {
  if (field === "type") return node.type;
  if (Object.prototype.hasOwnProperty.call(node.properties, field)) return node.properties[field];
  switch (field) {
    case "name":
      return node.name;
    case "confidence":
      return node.confidence;
    default:
      return undefined;
  }
}

function satisfies(cond: WhereCondition, nodes: Record<string, KGNode>): boolean {
  const node = nodes[cond.variable];
  if (!node) return false;
  const actual = fieldOf(node, cond.field);
  const want = cond.value;
  switch (cond.operator) {
    case "=":
      return actual === want || String(actual) === String(want);
    case "CONTAINS":
      return typeof actual === "string" && actual.toLowerCase().includes(String(want).toLowerCase());
    default: {
      if (typeof actual !== "number" || typeof want !== "number") return false;
      switch (cond.operator) {
        case "<":
          return actual < want;
        case ">":
          return actual > want;
        case "<=":
          return actual <= want;
        case ">=":
          return actual >= want;
      }
    }
  }
  return false;
}

/**
 * Run a Cypher-subset query against any KGStore. Node-label and predicate
 * filters are pushed down into findNodes/findEdges where the store supports
 * them; WHERE filters apply to the resolved endpoints.
 */
function columnsOf(parsed: CypherQuery): string[] {
  if (parsed.projections) return parsed.projections.map((p) => p.alias);
  const vars = [parsed.step.subject];
  if (parsed.step.object) vars.push(parsed.step.object);
  return vars;
}

/**
 * Run a Cypher-subset query against any KGStore. Node-label and predicate
 * filters are pushed down into findNodes/findEdges where the store supports
 * them; WHERE filters apply to the resolved endpoints.
 */
export async function runCypher(store: KGStore, query: string): Promise<CypherResult> {
  const parsed = parseCypher(query);
  const { step } = parsed;
  const columns = columnsOf(parsed);

  const subjects = await store.findNodes(
    step.subjectLabel ? { type: step.subjectLabel as never, limit: 10000 } : { limit: 10000 },
  );
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const emit = (row: Record<string, unknown>): boolean => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(row);
    return parsed.limit !== undefined && out.length >= parsed.limit;
  };
  const project = (bound: Record<string, KGNode>): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    if (parsed.projections) {
      for (const proj of parsed.projections) {
        row[proj.alias] = proj.field ? fieldOf(bound[proj.variable]!, proj.field) : bound[proj.variable];
      }
    } else {
      for (const v of columns) row[v] = bound[v];
    }
    return row;
  };
  const passWhere = (bound: Record<string, KGNode>): boolean =>
    parsed.where.every((c) => satisfies(c, bound));

  for (const subject of subjects) {
    if (step.object === undefined) {
      const bound = { [step.subject]: subject };
      if (passWhere(bound) && emit(project(bound))) {
        return { columns, rows: out };
      }
      continue;
    }
    const edges = await store.findEdges({
      subjectId: subject.id,
      ...(step.predicate ? { predicate: step.predicate.toLowerCase() } : {}),
      limit: 10000,
    });
    for (const edge of edges) {
      const object = await store.getNode(edge.objectId);
      if (!object) continue;
      if (step.objectLabel && object.type !== step.objectLabel) continue;
      const bound = { [step.subject]: subject, [step.object]: object };
      if (passWhere(bound) && emit(project(bound))) {
        return { columns, rows: out };
      }
    }
  }

  return { columns, rows: out };
}