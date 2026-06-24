// SPDX-License-Identifier: Apache-2.0
/**
 * memory_entries — persistent vector memory for agent long-term recall.
 *
 * Requires the pgvector extension enabled in Postgres:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *
 * PgVectorStore (packages/memory) calls ensureSchema() on first use to
 * create the extension and table automatically — no manual migration needed.
 *
 * Embedding dimensions: 768 (nomic-embed-text-v1.5 via GroqEmbedder).
 * Search: cosine similarity via pgvector `<=>` operator.
 */

import { customType, index, pgTable, text, integer, jsonb } from "drizzle-orm/pg-core";

// ── pgvector custom column type ───────────────────────────────────────────────

/**
 * Custom Drizzle column type for pgvector `vector(N)`.
 * Serialises number[] ↔ Postgres '[1.0,2.0,...]' string notation.
 */
export function vectorColumn(name: string, dimensions: number) {
  return customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      // Postgres returns '[1.0,2.0,...]'
      return value
        .slice(1, -1)
        .split(",")
        .map((v) => parseFloat(v));
    },
  })(name);
}

// ── Table definition ──────────────────────────────────────────────────────────

export const MEMORY_EMBEDDING_DIM = 768; // nomic-embed-text-v1.5

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    /** The original text that was remembered */
    text: text("text").notNull(),
    /** Float32 vector — 768 dims for nomic-embed-text-v1.5 */
    embedding: vectorColumn("embedding", MEMORY_EMBEDDING_DIM).notNull(),
    /** Arbitrary JSON metadata (agentId, source, tags, …) */
    metadata: jsonb("metadata").notNull().default({}),
    /** Unix epoch seconds */
    createdAt: integer("created_at").notNull(),
    /** Optional TTL — logically expired after this epoch second */
    expiresAt: integer("expires_at"),
    /** Multi-tenant ACL — owning user/tenant identifier */
    userId: text("user_id"),
  },
  (t) => [
    index("memory_entries_created_at_idx").on(t.createdAt),
    index("memory_entries_user_id_idx").on(t.userId),
  ],
);

export type MemoryEntryRow = typeof memoryEntries.$inferSelect;
export type NewMemoryEntryRow = typeof memoryEntries.$inferInsert;
