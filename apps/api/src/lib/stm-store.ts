// SPDX-License-Identifier: Apache-2.0
/**
 * Short-term-memory state, per user and durable.
 *
 * The autotune history, the active module list and the per-project overrides
 * were one process-global array and two module-level variables, so on any
 * deployment with more than one account every user read and wrote the same
 * rows: one person's prompts were visible to everyone, and toggling a module
 * toggled it for the whole server. Both are tenant-isolation defects rather
 * than missing features.
 *
 * Storage is `PersistentStore` — Postgres when DATABASE_URL is set, a JSON file
 * otherwise — so the state also survives a restart.
 */

import crypto from "node:crypto";

import { PersistentStore } from "./persistent-store.js";

interface StmHistoryEntry {
  id: string;
  ownerId: string;
  query: string;
  modules: string[];
  applied: string[];
  params: Record<string, unknown>;
  ts: string;
}

interface StmSettings {
  /** The owner id: one settings row per user. */
  id: string;
  modules: string[];
  /** Project id → the module list that overrides the owner's default. */
  projects: Record<string, string[]>;
}

const DEFAULT_STM_MODULES = ["hedge", "dir", "ema"];

/** Entries kept per user. Older ones fall off the end. */
const STM_HISTORY_CAP = 200;

const _history = new PersistentStore<StmHistoryEntry>("stm-history");
const _settings = new PersistentStore<StmSettings>("stm-settings");
let _loaded: Promise<void> | null = null;

export function loadStmStore(): Promise<void> {
  _loaded ??= Promise.all([_history.load(), _settings.load()]).then(() => undefined);
  return _loaded;
}

/** Reset the load latch. Tests use this to prove rows survive a fresh boot. */
export function _resetStmStoreForTests(): void {
  _loaded = null;
}

/** One user's entries, newest first. */
export function listStmHistory(ownerId: string): StmHistoryEntry[] {
  return [..._history.values()]
    .filter((e) => e.ownerId === ownerId)
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

export function recordStmEntry(
  ownerId: string,
  input: {
    query: string;
    modules: string[];
    applied: string[];
    params: Record<string, unknown>;
  },
): StmHistoryEntry {
  const entry: StmHistoryEntry = {
    id: crypto.randomUUID(),
    ownerId,
    query: input.query,
    modules: input.modules,
    applied: input.applied,
    params: input.params,
    ts: new Date().toISOString(),
  };
  _history.set(entry.id, entry);

  // The cap is per user: a busy account must not evict a quiet one's history.
  const mine = listStmHistory(ownerId);
  for (const old of mine.slice(STM_HISTORY_CAP)) _history.delete(old.id);

  return entry;
}

/** Clear one user's history. Returns how many entries were removed. */
export function clearStmHistory(ownerId: string): number {
  const mine = listStmHistory(ownerId);
  for (const entry of mine) _history.delete(entry.id);
  return mine.length;
}

function settingsFor(ownerId: string): StmSettings {
  return _settings.get(ownerId) ?? { id: ownerId, modules: [...DEFAULT_STM_MODULES], projects: {} };
}

export function getActiveModules(ownerId: string): string[] {
  return [...settingsFor(ownerId).modules];
}

export function setActiveModules(ownerId: string, modules: string[]): string[] {
  const next = { ...settingsFor(ownerId), modules: [...modules] };
  _settings.set(ownerId, next);
  return [...next.modules];
}

/** Toggle one module for this user, leaving the rest of the list untouched. */
export function toggleModule(ownerId: string, moduleId: string, enabled: boolean): string[] {
  const current = getActiveModules(ownerId);
  const next = enabled
    ? current.includes(moduleId)
      ? current
      : [...current, moduleId]
    : current.filter((m) => m !== moduleId);
  return setActiveModules(ownerId, next);
}

/** A project's module list, falling back to the owner's default. */
export function getProjectModules(ownerId: string, projectId: string): string[] {
  const settings = settingsFor(ownerId);
  return [...(settings.projects[projectId] ?? settings.modules)];
}

export function setProjectModules(ownerId: string, projectId: string, modules: string[]): string[] {
  const settings = settingsFor(ownerId);
  const next: StmSettings = {
    ...settings,
    projects: { ...settings.projects, [projectId]: [...modules] },
  };
  _settings.set(ownerId, next);
  return [...modules];
}
