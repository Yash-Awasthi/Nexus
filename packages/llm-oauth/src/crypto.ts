// SPDX-License-Identifier: Apache-2.0
/**
 * Crypto primitives: PKCE (RFC 7636) + an AES-256-GCM credential vault.
 *
 * The vault's wire format — base64(`[iv(12)|tag(16)|ciphertext]`) — is byte-for-byte
 * identical to apps/api/src/lib/secret-crypto.ts, so credentials sealed here can be
 * opened by the API layer's existing crypto and vice-versa. No new key system.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { Vault } from "./types.js";

// ── PKCE ────────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE verifier + S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Random URL-safe CSRF state token. */
export function randomState(): string {
  return base64url(randomBytes(24));
}

// ── AES-256-GCM vault ─────────────────────────────────────────────────────────

export class AesGcmVault implements Vault {
  /** @param key exactly 32 bytes (AES-256). */
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error(`AesGcmVault: key must be 32 bytes, got ${key.length}`);
    }
  }

  /**
   * Build from an env var holding a 32-byte key as base64 or hex. Returns null
   * when the var is unset/invalid so callers can degrade to "vault unavailable"
   * exactly like the BYOK path does, rather than crashing.
   */
  static fromEnv(envVar: string, env: NodeJS.ProcessEnv = process.env): AesGcmVault | null {
    const raw = env[envVar];
    if (!raw) return null;
    const key = decodeKey(raw);
    return key ? new AesGcmVault(key) : null;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  open(sealed: string): string {
    const buf = Buffer.from(sealed, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }
}

function decodeKey(raw: string): Buffer | null {
  // hex (64 chars) or base64 (44 chars for 32 bytes). Validate length is 32.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return null;
}
