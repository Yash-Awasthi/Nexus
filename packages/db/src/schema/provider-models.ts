// SPDX-License-Identifier: Apache-2.0
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";

/**
 * provider_models — model catalog seeded from models.dev (ROADMAP §1.5).
 *
 * One row per model definition from the models.dev catalogue (or a curated
 * fixture). Rows are written by `nexus models seed [--file <path>]` — never by
 * a startup network pull — and read into the in-memory ProviderRegistry at API
 * boot (§1.5: "boot reads the table; zero network at startup").
 *
 * Shape mirrors the ModelDefinition type in @nexus/provider-registry: ids are
 * namespaced `provider/model`, prices are USD per token (per-million divided by
 * 1e6, null = free), and capabilities is the six-flag capability record.
 */
export const providerModels = pgTable(
  "provider_models",
  {
    /** Namespaced model id, e.g. "anthropic/claude-3-5-sonnet-20241022". */
    id: text("id").primaryKey(),
    /** Provider slug, e.g. "anthropic". */
    provider: text("provider").notNull(),
    /** Human-readable display name. */
    name: text("name").notNull(),
    /** Context window in tokens. */
    contextWindow: integer("context_window").notNull().default(8192),
    /** Max output tokens. */
    maxOutputTokens: integer("max_output_tokens").notNull().default(4096),
    /** USD per input token (null = free). */
    costPerInputToken: doublePrecision("cost_per_input_token"),
    /** USD per output token (null = free). */
    costPerOutputToken: doublePrecision("cost_per_output_token"),
    /** USD per prompt-cache read token, when the model publishes one. */
    costPerCacheReadToken: doublePrecision("cost_per_cache_read_token"),
    /** USD per prompt-cache write token, when the model publishes one. */
    costPerCacheWriteToken: doublePrecision("cost_per_cache_write_token"),
    /** Input modalities, e.g. ["text","image"]. */
    inputModalities: jsonb("input_modalities").$type<string[]>(),
    /** Output modalities, e.g. ["text"]. */
    outputModalities: jsonb("output_modalities").$type<string[]>(),
    /** Knowledge cutoff, e.g. "2024-04". */
    knowledgeCutoff: text("knowledge_cutoff"),
    /** Release date, e.g. "2024-10-22". */
    releaseDate: text("release_date"),
    /** True when the model is retired/deprecated. */
    deprecated: boolean("deprecated").notNull().default(false),
    /** Capability flags {vision,functionCalling,streaming,promptCaching,jsonMode,systemPrompt}. */
    capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull().default({}),
    /** Where this row came from ("models.dev" or the fixture/file path). */
    source: text("source").notNull().default("models.dev"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("provider_models_provider_idx").on(t.provider)],
);

export type ProviderModelRow = typeof providerModels.$inferSelect;
export type NewProviderModelRow = typeof providerModels.$inferInsert;
