// SPDX-License-Identifier: Apache-2.0
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * forecast_runs — persisted forecast history.
 *
 * Written by apps/api/src/routes/forecast.ts on every successful generate call.
 * Survives process restarts; the in-process ForecastCache is an L1 cache on top.
 */
export const forecastRuns = pgTable("forecast_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** risk | market | geo | military */
  domain: text("domain").notNull(),
  /** 24h | 7d | 30d | 90d | 1y */
  horizon: text("horizon").notNull(),
  /** Full ForecastResult JSON blob */
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ForecastRun = typeof forecastRuns.$inferSelect;
export type NewForecastRun = typeof forecastRuns.$inferInsert;
