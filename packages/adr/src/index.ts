// SPDX-License-Identifier: Apache-2.0
/**
 * adr — Architecture Decision Record management for the Nexus platform.
 *
 * Provides:
 *   • AdrRecord       — the core ADR data structure (MADR format compatible)
 *   • AdrStore        — in-memory store for ADRs with CRUD + search
 *   • renderAdr()     — render an ADR to Markdown string
 *   • parseAdrNumber  — extract the numeric ID from an ADR title/filename
 *   • AdrStatus       — lifecycle: proposed → accepted | rejected | deprecated | superseded
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type AdrStatus = "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";

/** Adr record interface definition. */
export interface AdrRecord {
  id: number;
  title: string;
  status: AdrStatus;
  /** Date in YYYY-MM-DD format */
  date: string;
  deciders: string[];
  context: string;
  decision: string;
  consequences: string;
  alternatives?: string;
  /** ID of the ADR that supersedes this one (if status = "superseded") */
  supersededBy?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Create adr input interface definition. */
export interface CreateAdrInput {
  title: string;
  status?: AdrStatus;
  date?: string;
  deciders?: string[];
  context: string;
  decision: string;
  consequences: string;
  alternatives?: string;
  tags?: string[];
}

// ── AdrStore ──────────────────────────────────────────────────────────────────

export class AdrStore {
  private adrs = new Map<number, AdrRecord>();
  private nextId = 1;

  create(input: CreateAdrInput): AdrRecord {
    const now = new Date().toISOString();
    const adr: AdrRecord = {
      id: this.nextId++,
      title: input.title,
      status: input.status ?? "proposed",
      date: input.date ?? now.slice(0, 10),
      deciders: input.deciders ?? [],
      context: input.context,
      decision: input.decision,
      consequences: input.consequences,
      alternatives: input.alternatives,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.adrs.set(adr.id, adr);
    return adr;
  }

  get(id: number): AdrRecord | undefined {
    return this.adrs.get(id);
  }

  update(id: number, changes: Partial<Omit<AdrRecord, "id" | "createdAt">>): AdrRecord | undefined {
    const adr = this.adrs.get(id);
    if (!adr) return undefined;
    const updated: AdrRecord = {
      ...adr,
      ...changes,
      id,
      createdAt: adr.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.adrs.set(id, updated);
    return updated;
  }

  delete(id: number): boolean {
    return this.adrs.delete(id);
  }

  list(filter?: { status?: AdrStatus; tag?: string }): AdrRecord[] {
    let records = [...this.adrs.values()];
    if (filter?.status) records = records.filter((a) => a.status === filter.status);
    if (filter?.tag) records = records.filter((a) => a.tags?.includes(filter.tag!));
    return records.sort((a, b) => a.id - b.id);
  }

  search(query: string): AdrRecord[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.context.toLowerCase().includes(q) ||
        a.decision.toLowerCase().includes(q) ||
        a.consequences.toLowerCase().includes(q),
    );
  }

  supersede(oldId: number, newId: number): AdrRecord | undefined {
    return this.update(oldId, { status: "superseded", supersededBy: newId });
  }

  count(): number {
    return this.adrs.size;
  }
}

// ── renderAdr ─────────────────────────────────────────────────────────────────

/**
 * Render an ADR as a Markdown string (MADR-compatible format).
 */
export function renderAdr(adr: AdrRecord): string {
  const lines: string[] = [
    `# ${String(adr.id).padStart(4, "0")} ${adr.title}`,
    "",
    `* **Status:** ${adr.status}`,
    `* **Date:** ${adr.date}`,
  ];

  if (adr.deciders.length > 0) {
    lines.push(`* **Deciders:** ${adr.deciders.join(", ")}`);
  }

  if (adr.supersededBy !== undefined) {
    lines.push(`* **Superseded by:** ADR-${String(adr.supersededBy).padStart(4, "0")}`);
  }

  if (adr.tags && adr.tags.length > 0) {
    lines.push(`* **Tags:** ${adr.tags.map((t) => `\`${t}\``).join(", ")}`);
  }

  lines.push("", "## Context", "", adr.context);
  lines.push("", "## Decision", "", adr.decision);
  lines.push("", "## Consequences", "", adr.consequences);

  if (adr.alternatives) {
    lines.push("", "## Alternatives Considered", "", adr.alternatives);
  }

  return lines.join("\n");
}

// ── parseAdrNumber ────────────────────────────────────────────────────────────

/**
 * Extract the numeric ID from a string like "0012-use-typescript.md" or "ADR-0012".
 * Returns null if no number found.
 */
export function parseAdrNumber(input: string): number | null {
  const match = /(\d{1,4})/.exec(input);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

// ── Status transitions ─────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<AdrStatus, AdrStatus[]> = {
  proposed: ["accepted", "rejected"],
  accepted: ["deprecated", "superseded"],
  rejected: [],
  deprecated: [],
  superseded: [],
};

/** Can transition. */
export function canTransition(from: AdrStatus, to: AdrStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
