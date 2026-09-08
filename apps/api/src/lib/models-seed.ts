// SPDX-License-Identifier: Apache-2.0
/**
 * §1.5 models.dev seed — boot-time registry hydration from the DB.
 *
 * Loads the `provider_models` table into the in-memory ProviderRegistry the
 * billing cost model prices from. No network: the table is written offline by
 * `nexus models seed [--file <path>]`; boot only reads rows (ROADMAP §1.5:
 * "boot reads the table; zero network at startup").
 *
 * Best-effort by design: with no DATABASE_URL, an unreachable DB, or an empty
 * table this resolves to a count of 0 and the registry keeps its curated
 * defaults — seeding is an operator action, never a boot blocker.
 */
import {
  globalRegistry,
  registerFromProviderModelRows,
  type ProviderModelRowLike,
} from "@nexus/provider-registry";

/** Number of models loaded into the registry (0 when the table is absent/empty). */
export async function loadProviderModelsIntoRegistry(): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  try {
    const { db } = await import("@nexus/db");
    const { providerModels } = await import("@nexus/db/schema");
    const rows = (await db.select().from(providerModels)) as ProviderModelRowLike[];
    return registerFromProviderModelRows(globalRegistry, rows);
  } catch (err) {
    console.warn(
      `[models-seed] ⚠ provider_models load skipped: ${(err as Error).message}`,
    );
    return 0;
  }
}
