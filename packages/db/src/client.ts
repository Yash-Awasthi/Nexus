// SPDX-License-Identifier: Apache-2.0
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema/index.js";

/**
 * Nexus DB client — Drizzle ORM over Neon HTTP (serverless-safe).
 *
 * For worker processes that need a long-lived pooled connection, swap to
 * drizzle-orm/neon-serverless with a WebSocket pool — the schema import
 * is identical.
 *
 * Usage:
 *   import { db } from "@nexus/db";
 *   const tasks = await db.select().from(runtimeTasks).where(...);
 */
function createClient() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is required — set it in .env or Doppler");
  }
  const sql = neon(url);
  return drizzle(sql, { schema });
}

export const db = createClient();
export type NexusDB = typeof db;
