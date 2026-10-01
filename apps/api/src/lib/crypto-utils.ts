// SPDX-License-Identifier: Apache-2.0
/**
 * Shared cryptographic helpers.
 * Centralises common hash/sign patterns to avoid inline duplication.
 */

import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of a UTF-8 string.
 *
 * For high-entropy bearer tokens (random refresh/reset/API tokens) and
 * deterministic non-secret identifiers only — never for low-entropy passwords.
 * Passwords are hashed with scrypt (see hashPassword in routes/auth-users.ts).
 */
export function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
