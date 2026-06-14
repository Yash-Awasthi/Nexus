// SPDX-License-Identifier: Apache-2.0
import { neon } from "@neondatabase/serverless";
import { type NeonHttpDatabase, drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema/index.js";

/**
 * Nexus DB client — Drizzle ORM.
 *
 * Auto-detects the connection type from DATABASE_URL:
 *   - Neon cloud URLs (*.neon.tech / *.neon.host) → Neon HTTP driver
 *   - All other URLs (local dev, CI service containers) → standard pg Pool
 *
 * The public type is always NeonHttpDatabase so callers never need to change.
 *
 * Usage:
 *   import { db } from "@nexus/db";
 *   const tasks = await db.select().from(runtimeTasks).where(...);
 */

function isNeonUrl(url: string): boolean {
  return url.includes(".neon.tech") || url.includes(".neon.host");
}

function createClient(): NeonHttpDatabase<typeof schema> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required — set it in .env or Doppler");
  }

  if (isNeonUrl(url)) {
    const sql = neon(url);
    return drizzle(sql, { schema });
  }

  // Standard TCP Postgres — local dev containers, CI, self-hosted.
  // Cast to NeonHttpDatabase: both adapters implement the same query interface
  // and share identical method signatures for all operations we use.
  const pool = new Pool({ connectionString: url });
  return drizzlePg(pool, { schema }) as unknown as NeonHttpDatabase<typeof schema>;
}

export const db = createClient();
export type NexusDB = typeof db;
