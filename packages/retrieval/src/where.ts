// SPDX-License-Identifier: Apache-2.0
/**
 * Chroma-style where-clause filtering (collection.query/get `where` +
 * `where_document`), ported from chroma's API semantics.
 *
 * Grammar (mirrors chroma's validate_where / validate_where_document):
 *
 *   where            — a dict with EXACTLY ONE entry:
 *     { field: value }                        shorthand equality
 *     { field: { $eq | $ne | $gt | $gte | $lt | $lte | $in | $nin |
 *                $contains | $not_contains: operand } }
 *     { $and: [where, ...] }                  (≥ 2 entries)
 *     { $or:  [where, ...] }                  (≥ 2 entries)
 *   where_document   — document-text clause:
 *     { $contains: "text" } | { $not_contains: "text" }
 *     | { $and: [...] } | { $or: [...] }
 *
 * Evaluation semantics (matching chroma's property-test oracle in
 * test_filtering.py and the sqlite/typed-column executor):
 *   • Missing-key rules are operator-specific: $ne/$nin/$not_contains MATCH
 *     records whose field is absent; $eq/$in/$gt/$gte/$lt/$lte do not.
 *   • $gt/$gte/$lt/$lte are numeric-only comparisons.
 *   • Numbers compare by value (chroma unions its int and float columns, so
 *     `$eq: 5` matches a stored 5.0); strings/booleans compare strictly.
 *   • $contains/$not_contains on a metadata field test ARRAY membership.
 *   • Document $contains is a plain substring test; an empty document never
 *     contains and always not-contains.
 *   • $regex/$not_regex (sqlite/python dialect, e.g. inline `(?i)` flags) are
 *     NOT portable to JS RegExp semantics — out of scope here.
 */

export type Scalar = string | number | boolean;
export type MetadataValue = Scalar | Scalar[];

type FieldOperand =
  | { $eq?: Scalar }
  | { $ne?: Scalar }
  | { $gt?: number }
  | { $gte?: number }
  | { $lt?: number }
  | { $lte?: number }
  | { $in?: Scalar[] }
  | { $nin?: Scalar[] }
  | { $contains?: Scalar }
  | { $not_contains?: Scalar };

export type WhereClause =
  { $and: WhereClause[] } | { $or: WhereClause[] } | Record<string, Scalar | FieldOperand>;

export type WhereDocumentClause =
  | { $and: WhereDocumentClause[] }
  | { $or: WhereDocumentClause[] }
  | { $contains: string }
  | { $not_contains: string };

const WHERE_OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$contains",
  "$not_contains",
]);
const LOGICAL_OPERATORS = new Set(["$and", "$or"]);

/** Validate a where clause, raising the same classes of error chroma does. */
export function validateWhere(where: unknown, path = "$"): void {
  if (where === null || typeof where !== "object" || Array.isArray(where)) {
    throw new TypeError(`Expected where to be an object, got ${describe(where)} at ${path}`);
  }
  const entries = Object.entries(where as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Error(`Expected where at ${path} to have exactly one key, got ${entries.length}`);
  }
  const [key, value] = entries[0]!;
  if (LOGICAL_OPERATORS.has(key)) {
    if (!Array.isArray(value)) {
      throw new TypeError(`Expected ${key} to be an array of where clauses at ${path}`);
    }
    if (value.length < 2) {
      throw new Error(`Expected ${key} at ${path} to have at least two where clauses`);
    }
    for (const child of value) validateWhere(child, `${path}.${key}[...]`);
    return;
  }
  if (key === "$contains" || key === "$not_contains" || key.startsWith("$")) {
    throw new Error(
      `Expected where key to be a metadata field or $and/$or at ${path}, got "${key}"`,
    );
  }
  if (value === null || (typeof value === "object" && !Array.isArray(value))) {
    const opEntries = Object.entries(value as Record<string, unknown>);
    if (opEntries.length !== 1) {
      throw new Error(
        `Expected operator expression for field "${key}" to have exactly one operator at ${path}`,
      );
    }
    const [op, operand] = opEntries[0]!;
    if (!WHERE_OPERATORS.has(op)) {
      throw new Error(`Unknown where operator "${op}" at ${path}.${key}`);
    }
    if (["$gt", "$gte", "$lt", "$lte"].includes(op) && typeof operand !== "number") {
      throw new TypeError(`Expected ${op} operand to be a number at ${path}.${key}`);
    }
    if ((op === "$in" || op === "$nin") && !Array.isArray(operand)) {
      throw new TypeError(`Expected ${op} operand to be an array at ${path}.${key}`);
    }
    if (
      (op === "$in" || op === "$nin") &&
      Array.isArray(operand) &&
      (operand.length === 0 ||
        !operand.every((x, i) => isScalar(x) && (i === 0 || typeof x === typeof operand[0])))
    ) {
      throw new Error(
        `Expected ${op} operand to be a non-empty array of like-typed scalars at ${path}.${key}`,
      );
    }
  } else if (!isScalar(value)) {
    throw new TypeError(
      `Expected where value for field "${key}" to be a scalar or operator expression at ${path}`,
    );
  }
}

/** Validate a where_document clause against chroma's grammar. */
export function validateWhereDocument(whereDocument: unknown, path = "$"): void {
  if (whereDocument === null || typeof whereDocument !== "object" || Array.isArray(whereDocument)) {
    throw new TypeError(
      `Expected where_document to be an object, got ${describe(whereDocument)} at ${path}`,
    );
  }
  const entries = Object.entries(whereDocument as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Error(
      `Expected where_document at ${path} to have exactly one operator, got ${entries.length}`,
    );
  }
  const [op, operand] = entries[0]!;
  if (LOGICAL_OPERATORS.has(op)) {
    if (!Array.isArray(operand)) {
      throw new TypeError(`Expected ${op} to be an array at ${path}`);
    }
    if (operand.length < 2) {
      throw new Error(`Expected ${op} at ${path} to have at least two clauses`);
    }
    for (const child of operand) validateWhereDocument(child, `${path}.${op}[...]`);
    return;
  }
  if (!["$contains", "$not_contains"].includes(op)) {
    throw new Error(`Unknown where_document operator "${op}" at ${path}`);
  }
  if (typeof operand !== "string" || operand.length === 0) {
    throw new Error(`Expected ${op} operand to be a non-empty string at ${path}`);
  }
}

function isScalar(x: unknown): x is Scalar {
  return typeof x === "string" || typeof x === "number" || typeof x === "boolean";
}

function describe(x: unknown): string {
  if (x === null) return "null";
  return Array.isArray(x) ? "array" : typeof x;
}

function scalarEqual(a: Scalar, b: Scalar): boolean {
  // Numbers compare by value (chroma unions int + float storage); other
  // scalars compare strictly.
  return typeof a === "number" && typeof b === "number" ? a === b : a === b;
}

function metadataFieldPresent(
  metadata: Record<string, unknown> | undefined,
  field: string,
): metadata is Record<string, unknown> {
  return metadata !== undefined && field in metadata && metadata[field] !== undefined;
}

function compareOrdered(
  field: string,
  metadata: Record<string, unknown> | undefined,
  op: string,
  operand: number,
): boolean {
  if (!metadataFieldPresent(metadata, field)) return false;
  const v = metadata[field];
  if (typeof v !== "number") return false;
  switch (op) {
    case "$gt":
      return v > operand;
    case "$gte":
      return v >= operand;
    case "$lt":
      return v < operand;
    default:
      return v <= operand;
  }
}

/**
 * Evaluate a single operator expression `{ field: { $op: operand } }`.
 * `field` is the metadata key and `operatorSpec` the single-entry operator dict.
 */
function evalFieldOperand(
  metadata: Record<string, unknown> | undefined,
  field: string,
  operatorSpec: FieldOperand,
): boolean {
  const [op, operand] = Object.entries(operatorSpec as Record<string, unknown>)[0]!;
  switch (op) {
    case "$eq": {
      const s = operand as Scalar;
      return metadataFieldPresent(metadata, field) && scalarEqual(metadata[field] as Scalar, s);
    }
    case "$ne": {
      const s = operand as Scalar;
      return !metadataFieldPresent(metadata, field) || !scalarEqual(metadata[field] as Scalar, s);
    }
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
      return compareOrdered(field, metadata, op, operand as number);
    case "$in": {
      const list = operand as Scalar[];
      return (
        metadataFieldPresent(metadata, field) &&
        isScalar(metadata[field]) &&
        list.some((item) => scalarEqual(metadata[field] as Scalar, item))
      );
    }
    case "$nin": {
      const list = operand as Scalar[];
      return (
        !metadataFieldPresent(metadata, field) ||
        !isScalar(metadata[field]) ||
        !list.some((item) => scalarEqual(metadata[field] as Scalar, item))
      );
    }
    case "$contains": {
      // Array-membership test (chroma metadata $contains semantics).
      const target = operand as Scalar;
      if (!metadataFieldPresent(metadata, field)) return false;
      const v = metadata[field];
      return (
        Array.isArray(v) &&
        isScalar(target) &&
        v.some((item) => isScalar(item) && scalarEqual(item, target))
      );
    }
    case "$not_contains": {
      const target = operand as Scalar;
      if (!metadataFieldPresent(metadata, field)) return true;
      const v = metadata[field];
      if (!Array.isArray(v)) return true;
      return !v.some((item) => isScalar(item) && scalarEqual(item, target));
    }
    default:
      return false;
  }
}

/**
 * Evaluate a `where` clause against an entry's metadata map.
 * Returns true when the record satisfies the clause.
 */
export function whereMatches(
  metadata: Record<string, unknown> | undefined,
  where: WhereClause,
): boolean {
  const [key, value] = Object.entries(where as Record<string, unknown>)[0]!;
  if (key === "$and") return (value as WhereClause[]).every((c) => whereMatches(metadata, c));
  if (key === "$or") return (value as WhereClause[]).some((c) => whereMatches(metadata, c));
  // Field clause: shorthand scalar → equality; object → operator expression.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return evalFieldOperand(metadata, key, value as FieldOperand);
  }
  if (!metadataFieldPresent(metadata, key)) return false;
  return scalarEqual(metadata[key] as Scalar, value as Scalar);
}

/**
 * Evaluate a `where_document` clause against document text.
 * $contains is a substring test; empty documents never contain and always
 * not-contain (chroma's where-document semantics).
 */
export function whereDocumentMatches(
  documentText: string | undefined,
  whereDocument: WhereDocumentClause,
): boolean {
  const [op, operand] = Object.entries(whereDocument as Record<string, unknown>)[0]!;
  if (op === "$and") {
    return (operand as WhereDocumentClause[]).every((c) => whereDocumentMatches(documentText, c));
  }
  if (op === "$or") {
    return (operand as WhereDocumentClause[]).some((c) => whereDocumentMatches(documentText, c));
  }
  const text = documentText ?? "";
  if (op === "$contains") return text.includes(operand as string);
  return !text.includes(operand as string);
}
