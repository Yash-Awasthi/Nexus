// SPDX-License-Identifier: Apache-2.0
/**
 * Archetype registry — the single source of council membership.
 *
 * Rows are per-user and durable (PersistentStore: Postgres when DATABASE_URL is
 * set, a JSON file otherwise). The built-in personas in
 * `packages/council/src/archetypes.ts` are seeded here on first load and stay
 * read-only; the const is the seed source, not something an engine reads
 * directly. Every council path resolves its members through
 * `resolveCouncilMembers`, so a custom archetype votes on the model and
 * temperature its owner assigned it.
 *
 * Callers without an identity (dev bypass, or the master API key, which owns no
 * user) share the ANON_OWNER bucket. That bucket is not a security boundary —
 * it exists so an unauthenticated development server still behaves like the
 * real thing.
 */

import crypto from "node:crypto";

import { ARCHETYPES, summonArchetypes, type Archetype, type TaskCategory } from "@nexus/council";

import { PersistentStore } from "./persistent-store.js";

/** Owner of the seeded built-in personas. Not a real user id. */
const BUILTIN_OWNER = "__builtin__";

export { ANON_OWNER } from "./owner.js";

export interface ArchetypeRecord {
  id: string;
  ownerId: string;
  name: string;
  icon?: string;
  color?: string;
  thinkingStyle: string;
  description?: string;
  asks?: string;
  blindSpot?: string;
  systemPrompt: string;
  /** Model this member votes on. Unset means the council default. */
  model?: string;
  temperature?: number;
  builtin: boolean;
  createdAt: string;
}

/** Fields a caller may set. `id`, `ownerId`, `builtin` and `createdAt` are ours. */
export type ArchetypeInput = Partial<
  Omit<ArchetypeRecord, "id" | "ownerId" | "builtin" | "createdAt">
>;

/** Why a write was refused. `not_found` also covers another owner's row. */
type WriteFailure = "not_found" | "readonly";

const _store = new PersistentStore<ArchetypeRecord>("archetypes");
let _loaded: Promise<void> | null = null;

/** Hydrate the store and seed any built-in persona that is not present yet. */
export function loadArchetypeStore(): Promise<void> {
  if (_loaded) return _loaded;
  _loaded = (async () => {
    await _store.load();
    for (const a of Object.values(ARCHETYPES) as Archetype[]) {
      if (_store.has(a.id)) continue;
      _store.set(a.id, {
        id: a.id,
        ownerId: BUILTIN_OWNER,
        name: a.name,
        thinkingStyle: a.thinkingStyle,
        asks: a.asks,
        blindSpot: a.blindSpot,
        systemPrompt: a.systemPrompt,
        builtin: true,
        createdAt: new Date().toISOString(),
      });
    }
    // An older archetypes page saved every built-in as the user's own; an
    // unedited copy only duplicates the persona it came from.
    const builtins = new Set(
      [..._store.values()].filter((r) => r.builtin).map((r) => `${r.name}\n${r.systemPrompt}`),
    );
    for (const r of [..._store.values()])
      if (
        !r.builtin &&
        r.model === undefined &&
        r.temperature === undefined &&
        builtins.has(`${r.name}\n${r.systemPrompt}`)
      )
        _store.delete(r.id);
  })();
  return _loaded;
}

function owns(record: ArchetypeRecord, ownerId: string): boolean {
  return record.ownerId === ownerId || record.ownerId === BUILTIN_OWNER;
}

/** Built-in personas plus the caller's own, oldest first. */
export function listArchetypes(ownerId: string): ArchetypeRecord[] {
  return [..._store.values()]
    .filter((r) => owns(r, ownerId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Only the caller's own rows — what the UI asks for with `?custom=true`. */
export function listCustomArchetypes(ownerId: string): ArchetypeRecord[] {
  return listArchetypes(ownerId).filter((r) => !r.builtin);
}

export function createArchetype(ownerId: string, input: ArchetypeInput): ArchetypeRecord {
  const record: ArchetypeRecord = {
    ...input,
    id: crypto.randomUUID(),
    ownerId,
    name: input.name?.trim() || "Untitled archetype",
    thinkingStyle: input.thinkingStyle ?? "",
    systemPrompt: input.systemPrompt ?? "",
    builtin: false,
    createdAt: new Date().toISOString(),
  };
  _store.set(record.id, record);
  return record;
}

export function updateArchetype(
  ownerId: string,
  id: string,
  patch: ArchetypeInput,
): ArchetypeRecord | WriteFailure {
  const existing = _store.get(id);
  if (!existing || existing.ownerId !== ownerId) {
    return existing?.builtin ? "readonly" : "not_found";
  }
  const next: ArchetypeRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    ownerId: existing.ownerId,
    builtin: existing.builtin,
    createdAt: existing.createdAt,
  };
  _store.set(id, next);
  return next;
}

export function deleteArchetype(ownerId: string, id: string): true | WriteFailure {
  const existing = _store.get(id);
  if (!existing || existing.ownerId !== ownerId) {
    return existing?.builtin ? "readonly" : "not_found";
  }
  _store.delete(id);
  return true;
}

/** A stored row as the engine wants it, carrying the owner's model choice. */
function toArchetype(r: ArchetypeRecord): Archetype {
  return {
    id: r.id,
    name: r.name,
    thinkingStyle: r.thinkingStyle,
    asks: r.asks ?? "",
    blindSpot: r.blindSpot ?? "",
    // A custom persona with no prompt would otherwise vote as a blank system
    // message; its description is the closest thing its author wrote.
    systemPrompt: r.systemPrompt || r.description || `You are ${r.name}.`,
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
  };
}

/**
 * The member list for one deliberation: the caller's own archetypes first, then
 * the built-in summons for the task category fills the remaining seats.
 *
 * Custom members lead because an archetype a user created and never sees speak
 * is the exact defect this registry exists to fix.
 */
export function resolveCouncilMembers(
  ownerId: string,
  category: TaskCategory,
  size: number,
): Archetype[] {
  const custom = listCustomArchetypes(ownerId).slice(0, size).map(toArchetype);
  if (custom.length >= size) return custom;

  const taken = new Set(custom.map((a) => a.id));
  const seeded = new Map([..._store.values()].filter((r) => r.builtin).map((r) => [r.id, r]));
  const fill = summonArchetypes(category, size)
    .filter((a) => !taken.has(a.id))
    // Prefer the stored row: it is what a later stage will edit, and the const
    // may have drifted from what was seeded.
    .map((a) => {
      const row = seeded.get(a.id);
      return row ? toArchetype(row) : a;
    })
    .slice(0, size - custom.length);

  return [...custom, ...fill];
}

/**
 * One persona per seat. A seat naming an archetype the caller can see gets it;
 * with `fill`, the other seats take auto-summoned personas nobody picked.
 */
export function seatCouncil(
  ownerId: string,
  category: TaskCategory,
  picks: (string | undefined)[],
  fill: boolean,
): (Archetype | undefined)[] {
  const chosen = picks.map((id) => {
    const row = id ? _store.get(id) : undefined;
    return row && owns(row, ownerId) ? toArchetype(row) : undefined;
  });
  const taken = new Set(chosen.flatMap((a) => (a ? [a.id] : [])));
  const rest = fill
    ? resolveCouncilMembers(ownerId, category, picks.length).filter((a) => !taken.has(a.id))
    : [];
  return chosen.map((a) => a ?? rest.shift());
}
