// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the §1.5 models.dev seed (ROADMAP).
 *
 * Covers the catalogue→rows conversion (the exact mapping `modelsDevToDefinitions`
 * performs for the in-memory registry) and the upsert against a stub DB — no
 * real Postgres, no network. The fixture mirrors the trimmed models.dev
 * api.json shape already used by @nexus/provider-registry's tests.
 */
import { describe, it, expect, vi } from "vitest";

import {
  MODELS_DEV_FIXTURE,
  catalogueToRows,
  loadModelsDevSource,
  upsertProviderModels,
  type SeedDb,
} from "../../src/lib/models-seed.js";
import { rowToModelDefinition } from "@nexus/provider-registry";

/** Capture the insert calls a stub DB receives. */
function makeStubDb(): { db: SeedDb; calls: { row: unknown; set: unknown }[] } {
  const calls: { row: unknown; set: unknown }[] = [];
  const db = {
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: (arg: { set: unknown }) => ({
          returning: async () => {
            calls.push({ row, set: arg.set });
            return [{ id: (row as { id: string }).id }];
          },
        }),
      }),
    }),
  } as unknown as SeedDb;
  return { db, calls };
}

describe("catalogueToRows", () => {
  const rows = catalogueToRows(MODELS_DEV_FIXTURE);
  const sonnet = rows.find((r) => r.id === "anthropic/claude-3-5-sonnet-20241022")!;

  it("namespaces ids as provider/model and flattens every provider", () => {
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain("groq/llama-3.1-8b-instant");
  });

  it("converts per-million pricing to per-token", () => {
    expect(sonnet.costPerInputToken).toBeCloseTo(3e-6, 12);
    expect(sonnet.costPerOutputToken).toBeCloseTo(15e-6, 12);
    expect(sonnet.costPerCacheReadToken).toBeCloseTo(0.3e-6, 12);
    expect(sonnet.costPerCacheWriteToken).toBeCloseTo(3.75e-6, 12);
  });

  it("maps limits, modalities, cutoff and release date", () => {
    expect(sonnet.contextWindow).toBe(200_000);
    expect(sonnet.maxOutputTokens).toBe(8192);
    expect(sonnet.inputModalities).toEqual(["text", "image"]);
    expect(sonnet.knowledgeCutoff).toBe("2024-04");
    expect(sonnet.releaseDate).toBe("2024-10-22");
  });

  it("derives capabilities from modality / tool_call / cache_read", () => {
    expect(sonnet.capabilities).toMatchObject({
      vision: true,
      functionCalling: true,
      promptCaching: true,
    });
    const groq = rows.find((r) => r.id === "groq/llama-3.1-8b-instant")!;
    expect(groq.capabilities).toMatchObject({ vision: false, promptCaching: false });
  });

  it("round-trips through rowToModelDefinition into registry-pricable shapes", () => {
    const def = rowToModelDefinition(sonnet);
    expect(def.id).toBe("anthropic/claude-3-5-sonnet-20241022");
    expect(def.inputCost).toBeCloseTo(3, 9); // per-token 3e-6 → $3/MTok
    expect(def.vision).toBe(true);
  });
});

describe("upsertProviderModels", () => {
  it("upserts every row with ON CONFLICT (id) and returns the written count", async () => {
    const { db, calls } = makeStubDb();
    const rows = catalogueToRows(MODELS_DEV_FIXTURE);
    const written = await upsertProviderModels(db, rows);
    expect(written).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.set).toMatchObject({ provider: "anthropic" });
  });

  it("writes nothing for an empty row set", async () => {
    const { db, calls } = makeStubDb();
    expect(await upsertProviderModels(db, [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("loadModelsDevSource", () => {
  it("defaults to the built-in fixture with source=fixture (no network)", async () => {
    const src = await loadModelsDevSource();
    expect(src.source).toBe("fixture");
    expect(src.catalogue.anthropic?.models?.["claude-3-5-sonnet-20241022"]).toBeDefined();
  });

  it("reads a --file JSON catalogue and labels the source with the path", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "nexus-seed-"));
    const file = join(dir, "api.json");
    try {
      await writeFile(file, JSON.stringify(MODELS_DEV_FIXTURE), "utf8");
      const src = await loadModelsDevSource(file);
      expect(src.source).toBe(file);
      expect(Object.keys(src.catalogue)).toContain("groq");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
