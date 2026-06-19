// SPDX-License-Identifier: Apache-2.0
/**
 * Shared cryptographic helpers.
 * Centralises common hash/sign patterns to avoid inline duplication.
 */

import { createHash, createHmac } from "node:crypto";

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA-256 hex of data with a secret. */
export function hmacSha256hex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}
