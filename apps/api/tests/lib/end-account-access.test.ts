// SPDX-License-Identifier: Apache-2.0
/** An account that is suspended, deleted or claimed keeps no personal access token working. */
import crypto from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:end-account-access";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { createPat, verifyPat } = await import("../../src/lib/pat-store.ts");
const { endAccountAccess } = await import("../../src/lib/session-revocation.ts");

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
});

afterAll(async () => {
  await closePgPools();
});

it("revokes every token the account holds and leaves other accounts' tokens alone", async () => {
  const ending = crypto.randomUUID();
  const { raw: first } = await createPat({ ownerId: ending, name: "ci" });
  const { raw: second } = await createPat({ ownerId: ending, name: "laptop" });
  const { raw: other } = await createPat({ ownerId: crypto.randomUUID(), name: "ci" });

  await endAccountAccess(ending);

  expect(await verifyPat(first)).toBeNull();
  expect(await verifyPat(second)).toBeNull();
  expect(await verifyPat(other)).not.toBeNull();
});
