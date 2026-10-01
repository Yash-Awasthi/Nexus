// SPDX-License-Identifier: Apache-2.0
/** Make an existing account an admin. Run from inside the deployment (see src/grant-admin.ts). */
import type { PgLike } from "./pg-pool.js";

export async function grantAdmin(pool: PgLike, email: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    "UPDATE users SET role = 'admin' WHERE lower(email) = $1 AND deleted_at IS NULL RETURNING id",
    [email.trim().toLowerCase()],
  );
  return rows.length > 0;
}
