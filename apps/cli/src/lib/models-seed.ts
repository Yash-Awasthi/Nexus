// SPDX-License-Identifier: Apache-2.0
/**
 * models.dev seed library — shared by `nexus models seed` and the API boot path.
 *
 * Converts a models.dev catalogue (api.json shape) into `provider_models` rows
 * and upserts them into the DB. No network here: the catalogue comes from a
 * file, stdin-style argument, or the built-in fixture. A live `fetchModelsDev`
 * pull is a Gate (ROADMAP §1.5) and stays out of this module.
 *
 * The models.dev fixture mirrors the trimmed catalogue shape already used by
 * @nexus/provider-registry's tests, so the default `nexus models seed` run is
 * deterministic and testable without network.
 */
import type { NewProviderModelRow } from "@nexus/db/schema";

// ── models.dev api.json shape (structural — @nexus/provider-registry no longer
// exports a catalogue type; the trimmed shape mirrors what its tests use). ────

export interface ModelsDevModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModelLimit {
  context?: number;
  output?: number;
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  attachment?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  cost?: ModelsDevModelCost;
  limit?: ModelsDevModelLimit;
}

export interface ModelsDevProviderEntry {
  id?: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
}

/** models.dev api.json — providers keyed by slug. */
export type ModelsDevCatalogue = Record<string, ModelsDevProviderEntry>;

/** Trimmed catalogue mirroring the models.dev api.json shape (deterministic seed). */
export const MODELS_DEV_FIXTURE: ModelsDevCatalogue = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-5-sonnet-20241022": {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        attachment: true,
        tool_call: true,
        knowledge: "2024-04",
        release_date: "2024-10-22",
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200_000, output: 8192 },
      },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.1-8b-instant": {
        name: "Llama 3.1 8B",
        tool_call: false,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.05, output: 0.08 },
        limit: { context: 128_000, output: 8192 },
      },
    },
  },
};

const PER_MILLION = 1_000_000;

/**
 * Convert a models.dev catalogue into seed rows (one per model). Ids are
 * namespaced `provider/model`; per-million prices become per-token. Mirrors
 * the conversion `modelsDevToDefinitions` performs for the in-memory registry.
 */
export function catalogueToRows(
  catalogue: ModelsDevCatalogue,
  source = "models.dev",
): NewProviderModelRow[] {
  const rows: NewProviderModelRow[] = [];
  for (const [providerKey, entry] of Object.entries(catalogue)) {
    const models = entry?.models ?? {};
    for (const [modelKey, model] of Object.entries(models)) {
      const cost = model.cost ?? {};
      const limit = model.limit ?? {};
      const inputModalities = model.modalities?.input ?? ["text"];
      const outputModalities = model.modalities?.output ?? ["text"];
      rows.push({
        id: `${providerKey}/${modelKey}`,
        provider: providerKey,
        name: model.name ?? modelKey,
        contextWindow: limit.context ?? 8192,
        maxOutputTokens: limit.output ?? 4096,
        costPerInputToken: cost.input != null ? cost.input / PER_MILLION : null,
        costPerOutputToken: cost.output != null ? cost.output / PER_MILLION : null,
        costPerCacheReadToken: cost.cache_read != null ? cost.cache_read / PER_MILLION : null,
        costPerCacheWriteToken: cost.cache_write != null ? cost.cache_write / PER_MILLION : null,
        inputModalities,
        outputModalities,
        knowledgeCutoff: model.knowledge ?? null,
        releaseDate: model.release_date ?? null,
        deprecated: false,
        capabilities: {
          vision: inputModalities.includes("image"),
          functionCalling: model.tool_call === true,
          streaming: true,
          promptCaching: cost.cache_read != null,
          jsonMode: true,
          systemPrompt: true,
        },
        source,
      });
    }
  }
  return rows;
}

/** Minimal writable-DB surface so the seed can be unit-tested with a stub. */
export interface SeedDb {
  insert(table: unknown): {
    values(row: unknown): {
      onConflictDoUpdate(arg: { target: unknown; set: Record<string, unknown> }): {
        returning(): Promise<unknown[]>;
      };
    };
  };
}

/**
 * Upsert rows into `provider_models` (ON CONFLICT (id) DO UPDATE). Returns the
 * number of rows written.
 */
export async function upsertProviderModels(
  db: SeedDb,
  rows: NewProviderModelRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { providerModels } = await import("@nexus/db/schema");
  const written: unknown[] = [];
  for (const row of rows) {
    const result = await db
      .insert(providerModels)
      .values(row)
      .onConflictDoUpdate({
        target: providerModels.id,
        set: {
          provider: row.provider,
          name: row.name,
          contextWindow: row.contextWindow,
          maxOutputTokens: row.maxOutputTokens,
          costPerInputToken: row.costPerInputToken,
          costPerOutputToken: row.costPerOutputToken,
          costPerCacheReadToken: row.costPerCacheReadToken,
          costPerCacheWriteToken: row.costPerCacheWriteToken,
          inputModalities: row.inputModalities,
          outputModalities: row.outputModalities,
          knowledgeCutoff: row.knowledgeCutoff,
          releaseDate: row.releaseDate,
          deprecated: row.deprecated,
          capabilities: row.capabilities,
          source: row.source,
          updatedAt: new Date(),
        },
      })
      .returning();
    written.push(...result);
  }
  return written.length;
}

/**
 * Seed from a models.dev catalogue object. `source` records where the data
 * came from (file path or "fixture").
 */
export async function seedFromCatalogue(
  db: SeedDb,
  catalogue: ModelsDevCatalogue,
  source = "models.dev",
): Promise<number> {
  return upsertProviderModels(db, catalogueToRows(catalogue, source));
}

/** A catalogue plus a label of where it was loaded from. */
export interface ModelsDevSource {
  catalogue: ModelsDevCatalogue;
  source: string;
}

/**
 * Load the seed source without touching the network: `--file <path>` reads a
 * models.dev api.json-shaped JSON file; no flag uses the built-in fixture.
 * (A live fetchModelsDev pull is a Gate per ROADMAP §1.5.)
 */
export async function loadModelsDevSource(file?: string): Promise<ModelsDevSource> {
  if (!file) return { catalogue: MODELS_DEV_FIXTURE, source: "fixture" };
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(file, "utf8");
  return { catalogue: JSON.parse(text) as ModelsDevCatalogue, source: file };
}

/**
 * Convert + upsert a loaded source into the DB via @nexus/db. Returns the
 * number of rows written. DATABASE_URL must be set (the @nexus/db client
 * throws at import time otherwise).
 */
export async function seedModelsFromSource(src: ModelsDevSource): Promise<number> {
  const { db } = await import("@nexus/db");
  return seedFromCatalogue(db as unknown as SeedDb, src.catalogue, src.source);
}
