// SPDX-License-Identifier: Apache-2.0
/**
 * `node dist/grant-admin.js <email>`: make that account an admin. Only someone who can run
 * commands in the deployment can do this, which is what makes it safe; the account signs in
 * again to pick up the role.
 */
import { grantAdmin } from "./lib/grant-admin.js";
import { closePgPools, getPgPool } from "./lib/pg-pool.js";

const email = process.argv[2];
const pool = getPgPool();
if (!email || !pool) {
  console.error("usage: node dist/grant-admin.js <email>   (DATABASE_URL must be set)");
  process.exit(1);
}
try {
  const done = await grantAdmin(pool, email);
  console.log(done ? `${email} is now an admin.` : `No account with email ${email}.`);
  if (!done) process.exitCode = 1;
} finally {
  await closePgPools();
}
