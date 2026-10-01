// SPDX-License-Identifier: Apache-2.0
/**
 * Shared symmetric secret encryption for data stored at rest (e.g. BYOK provider
 * API keys). AES-256-GCM with a random 12-byte IV; the serialized form is
 * base64 of `[iv(12) | authTag(16) | ciphertext]`.
 *
 * The 32-byte key must be set via NEXUS_SECRETS_KEY as a 64-char hex string.
 * Each purpose (MFA, OAuth) uses its own key — no implicit fallback chain.
 *
 * This module FAILS CLOSED: if no key is configured, encrypt/decrypt throw
 * `SecretCryptoUnavailableError`. Callers that persist secrets must surface
 * this as a 5xx and refuse to store anything.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SECRET_KEY_ENV = "NEXUS_SECRETS_KEY";

/** Raised when no valid 32-byte encryption key is configured. */
export class SecretCryptoUnavailableError extends Error {
  readonly code = "encryption_unavailable";
  constructor() {
    super("No secret-encryption key configured. Set NEXUS_SECRETS_KEY to a 64-char hex string.");
    this.name = "SecretCryptoUnavailableError";
  }
}

/** Resolve the 32-byte key from NEXUS_SECRETS_KEY, or null if not a valid 64-hex string. */
export function getSecretKey(): Buffer | null {
  const hex = process.env[SECRET_KEY_ENV];
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  return null;
}

/** True when a usable encryption key is configured. */
export function isSecretCryptoAvailable(): boolean {
  return getSecretKey() !== null;
}

/**
 * Low-level AES-256-GCM encrypt with an explicit 32-byte key →
 * base64(`[iv(12)|tag(16)|ciphertext]`). Key resolution and fail/fallback policy
 * are the caller's concern — this is the shared primitive used by `encryptSecret`
 * as well as the MFA and connector vaults (which apply their own fallback rules).
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Low-level AES-256-GCM decrypt with an explicit 32-byte key. Throws on tamper. */
export function decryptWithKey(key: Buffer, stored: string): string {
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** Encrypt UTF-8 plaintext → base64(`[iv|tag|ciphertext]`). Throws if no key. */
export function encryptSecret(plaintext: string): string {
  const key = getSecretKey();
  if (!key) throw new SecretCryptoUnavailableError();
  return encryptWithKey(key, plaintext);
}

/** Decrypt a value produced by `encryptSecret`. Throws if no key or on tamper. */
export function decryptSecret(stored: string): string {
  const key = getSecretKey();
  if (!key) throw new SecretCryptoUnavailableError();
  return decryptWithKey(key, stored);
}
