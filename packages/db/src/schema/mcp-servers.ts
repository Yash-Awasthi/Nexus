// SPDX-License-Identifier: Apache-2.0
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── mcp_servers ─────────────────────────────────────────────────────────────────

/**
 * mcp_servers — per-user registry of external MCP (Model Context Protocol) servers.
 *
 * Replaces the previously config-hardcoded, in-memory server list with a
 * persisted, per-user registry. An optional API key is encrypted at rest with
 * AES-256-GCM (see apps/api secret-crypto); `encrypted_api_key` holds
 * base64(`[iv|tag|ciphertext]`). The raw key is NEVER stored in plaintext or
 * returned over HTTP — only `key_prefix` (first 8 chars) is shown in the UI, and
 * the key is decrypted server-side at "test"/invocation time. One active server
 * per (user, name); removal soft-deletes.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Transport: http | stdio | websocket */
    transportType: text("transport_type").notNull().default("http"),
    /** Server URL (http/websocket) or command (stdio) */
    endpoint: text("endpoint").notNull(),
    /** base64([iv|tag|ciphertext]) of the raw API key; nullable (keyless servers) */
    encryptedApiKey: text("encrypted_api_key"),
    /** First 8 chars of the raw key, for display */
    keyPrefix: text("key_prefix"),
    /** Extra transport config (headers, args, env) — non-secret */
    config: jsonb("config").$type<Record<string, unknown>>(),
    /** Tool names discovered on the last successful test/health check */
    tools: jsonb("tools").$type<string[]>(),
    /** Last known connection status: inactive | active | error */
    status: text("status").notNull().default("inactive"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Bumped on a successful test/health check */
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    /** Set on soft-delete; excluded from normal queries */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // One live server per (user, name).
    uniqueIndex("mcp_servers_user_name_udx")
      .on(t.userId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index("mcp_servers_user_id_idx").on(t.userId),
  ],
);

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
