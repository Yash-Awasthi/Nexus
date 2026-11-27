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

/**
 * The key this instance was using before a rotation, if one was set.
 *
 * Rotation in place is two deploys, not one: set `NEXUS_SECRETS_KEY` to the new key and `NEXUS_SECRETS_KEY_PREVIOUS`
 * to the old one, run the rotation so every row is re-encrypted, then drop the previous variable. Without the
 * second step the first deploy makes every stored credential unreadable — a rotation that only writes is a
 * rotation that loses data.
 */
export function getPreviousSecretKey(): Buffer | null {
  // Read by literal name so `check:env-docs` can see the read; a bracket lookup is a dynamic access and the scan
  // would report the variable as documented-but-unread, which is how a real gap hides behind a false positive.
  const hex = process.env.NEXUS_SECRETS_KEY_PREVIOUS;
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
 *
 * The bare form is version 1 of the key material. `encryptSecret` writes a
 * `v1:`-prefixed envelope around it so a future change of algorithm can be read
 * back without guessing at the base64 shape; both forms decrypt here.
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** The prefix written today. Rows stored before it existed carry no prefix and are read as v1. */
export const SECRET_ENVELOPE = "v1:";

/**
 * Raised for a `vN:` envelope this build does not know.
 *
 * Without this check an unknown prefix is just base64-shaped text, and the failure surfaces as a GCM tag error —
 * which says "wrong key" to an operator looking at a row that is actually from a newer build. Naming the version
 * keeps that diagnosis honest, and refusing means a downgrade cannot silently treat future ciphertext as v1.
 */
export class SecretEnvelopeVersionError extends Error {
  readonly code = "secret_envelope_unknown_version";
  readonly version: string;
  constructor(version: string) {
    super(
      `Unknown secret envelope version "${version}". This build reads "${SECRET_ENVELOPE}" and the prefixless ` +
        `legacy form; upgrade before reading these rows.`,
    );
    this.name = "SecretEnvelopeVersionError";
    this.version = version;
  }
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

/** Encrypt UTF-8 plaintext → `v1:` + base64(`[iv|tag|ciphertext]`). Throws if no key. */
export function encryptSecret(plaintext: string): string {
  const key = getSecretKey();
  if (!key) throw new SecretCryptoUnavailableError();
  return SECRET_ENVELOPE + encryptWithKey(key, plaintext);
}

/** Decrypt a value produced by `encryptSecret`. Throws if no key or on tamper. */
export function decryptSecret(stored: string): string {
  const key = getSecretKey();
  if (!key) throw new SecretCryptoUnavailableError();
  return decryptWithKey(key, unwrap(stored));
}

/**
 * Strip the envelope prefix. A row written before the prefix existed is returned unchanged, which is exactly how
 * rotation knows there is work to do: `stored === unwrap(stored)` means it is still version 1 on disk.
 *
 * A `vN:` prefix other than ours is refused by name rather than decoded as if it were base64. Base64 cannot contain
 * `:`, so the two shapes are unambiguous and the legacy form is never mistaken for a version.
 */
export function unwrap(stored: string): string {
  if (stored.startsWith(SECRET_ENVELOPE)) return stored.slice(SECRET_ENVELOPE.length);
  const versioned = /^(v\d+:)/.exec(stored);
  if (versioned) throw new SecretEnvelopeVersionError(versioned[1]!);
  return stored;
}

/** True when a stored value already carries the current envelope. */
export function isCurrentEnvelope(stored: string): boolean {
  return stored.startsWith(SECRET_ENVELOPE);
}

/**
 * Decrypt with the current key, falling back to the previous one during a rotation.
 *
 * Returns which key worked so the caller can tell "already rotated" from "read with the old key and needs
 * re-writing" without attempting the decryption twice.
 */
export function decryptSecretAnyKey(stored: string): {
  plaintext: string;
  key: "current" | "previous";
} {
  const body = unwrap(stored);
  const current = getSecretKey();
  if (current) {
    try {
      return { plaintext: decryptWithKey(current, body), key: "current" };
    } catch {
      // Fall through to the previous key; a GCM tag failure is the only way here.
    }
  }
  const previous = getPreviousSecretKey();
  if (previous) {
    try {
      return { plaintext: decryptWithKey(previous, body), key: "previous" };
    } catch {
      // Fall through: both keys failed, so the message names both rather than leaking one GCM tag error.
    }
  }
  if (!current && !previous) throw new SecretCryptoUnavailableError();
  throw new Error("Stored secret does not decrypt with the current or the previous key");
}
