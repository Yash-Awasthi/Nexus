// SPDX-License-Identifier: Apache-2.0
/**
 * MFA routes — TOTP (RFC 6238) multi-factor authentication.
 *
 * POST /api/v1/mfa/setup    — generate TOTP secret + QR URL (not yet active)
 * POST /api/v1/mfa/verify   — verify first code to activate MFA
 * POST /api/v1/mfa/validate — validate a TOTP code (called on each login if mfaEnabled)
 * POST /api/v1/mfa/disable  — disable MFA (requires valid TOTP code)
 * GET  /api/v1/mfa/status   — return { mfaEnabled } for current user
 *
 * TOTP implementation: RFC 6238 (HOTP + TOTP), HMAC-SHA1, 6-digit, 30-second window.
 * Secrets stored as base32-encoded strings using AES-256-GCM encryption at rest.
 * No external TOTP library — pure Node.js crypto.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { db } from "@nexus/db";
import { users } from "@nexus/db/schema";
import { eq, isNull, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { requireAuth } from "../middleware/auth.js";

// 5 MFA attempts per 15 minutes per IP — prevents brute-force TOTP attacks
const mfaRateLimit = makeRateLimitPreHandler({
  limit: 5,
  windowMs: 15 * 60 * 1000,
  keyPrefix: "auth:mfa",
});

// ── Base32 encoding/decoding (RFC 4648 — used by TOTP apps) ──────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str: string): Buffer {
  const cleaned = str.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── TOTP RFC 6238 ─────────────────────────────────────────────────────────────

/** Generate a 6-digit HOTP code from a base32 secret and counter (RFC 4226). */
function hotp(secretBase32: string, counter: bigint): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[19]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Verify a 6-digit TOTP code. Accepts a ±1 step window to handle clock drift. */
function verifyTotp(secretBase32: string, code: string, windowSteps = 1): boolean {
  const step = 30n;
  const counter = BigInt(Math.floor(Date.now() / 1000)) / step;
  for (let i = -windowSteps; i <= windowSteps; i++) {
    const expected = hotp(secretBase32, counter + BigInt(i));
    if (
      expected.length === code.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(code))
    ) {
      return true;
    }
  }
  return false;
}

/** Generate a random 20-byte TOTP secret encoded as base32 (160 bits — RFC 4226 §4). */
function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ── Secret encryption at rest ─────────────────────────────────────────────────

/** AES-256-GCM encrypt a TOTP secret. Returns base64: iv(12)+tag(16)+ciphertext. */
function encryptSecret(plaintext: string): string {
  const key = getEncKey();
  if (!key) return plaintext; // Unencrypted fallback when NEXUS_MFA_KEY unset
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** AES-256-GCM decrypt a stored TOTP secret. */
function decryptSecret(stored: string): string {
  const key = getEncKey();
  if (!key) return stored;
  try {
    const buf = Buffer.from(stored, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch {
    return stored; // Plaintext fallback
  }
}

function getEncKey(): Buffer | null {
  const hex = process.env.NEXUS_MFA_KEY ?? process.env.OAUTH_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  if (!process.env.DATABASE_URL) {
    const na = async (
      _: unknown,
      reply: { code: (n: number) => { send: (v: unknown) => unknown } },
    ) => reply.code(503).send({ error: "DATABASE_URL not configured" });
    app.get("/mfa/status", na);
    app.post("/mfa/setup", na);
    app.post("/mfa/verify", na);
    app.post("/mfa/validate", na);
    app.post("/mfa/disable", na);
    return;
  }

  /** GET /mfa/status — is MFA enabled for the current user? */
  app.get("/mfa/status", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });

    const [user] = await db
      .select({ mfaEnabled: users.mfaEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return reply.send({ mfaEnabled: user?.mfaEnabled ?? false });
  });

  /**
   * POST /mfa/setup
   *
   * Generate a new TOTP secret. The secret is stored in the DB but MFA is NOT
   * yet active — the user must call /mfa/verify with a valid code first.
   *
   * Returns:
   *   secret     — base32 TOTP secret (show to user once; they enter into authenticator app)
   *   otpauthUrl — otpauth:// URI for QR code generation
   */
  app.post("/mfa/setup", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });

    const [user] = await db
      .select({ email: users.email, mfaEnabled: users.mfaEnabled })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user) return reply.code(404).send({ error: "user_not_found" });
    if (user.mfaEnabled) {
      return reply
        .code(409)
        .send({ error: "mfa_already_enabled", message: "Disable existing MFA first" });
    }

    const secret = generateTotpSecret();
    const encryptedSecret = encryptSecret(secret);

    await db
      .update(users)
      .set({ totpSecret: encryptedSecret, mfaEnabled: false })
      .where(eq(users.id, userId));

    const issuer = process.env.NEXUS_MFA_ISSUER ?? "Nexus";
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

    return reply.send({
      secret,
      otpauthUrl,
      message:
        "Scan the QR code in your authenticator app, then call POST /mfa/verify with a valid code to activate.",
    });
  });

  /**
   * POST /mfa/verify
   *
   * Verify the first TOTP code to activate MFA.
   * Body: { code: "123456" }
   */
  app.post<{ Body: { code: string } }>(
    "/mfa/verify",
    {
      preHandler: [requireAuth, mfaRateLimit],
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });

      const [user] = await db
        .select({ totpSecret: users.totpSecret, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user?.totpSecret) {
        return reply.code(400).send({ error: "setup_required", message: "Call /mfa/setup first" });
      }
      if (user.mfaEnabled) {
        return reply.code(409).send({ error: "mfa_already_enabled" });
      }

      const secret = decryptSecret(user.totpSecret);
      const valid = verifyTotp(secret, request.body.code);
      if (!valid) {
        return reply
          .code(400)
          .send({ error: "invalid_code", message: "Invalid or expired TOTP code" });
      }

      await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, userId));

      emitAuditEvent(
        { entityType: "user", entityId: userId, action: "mfa.enabled", actor: userId },
        app.log,
      );

      return reply.send({ mfaEnabled: true, message: "MFA activated successfully" });
    },
  );

  /**
   * POST /mfa/validate
   *
   * Validate a TOTP code during login (when mfaEnabled = true).
   * Called after password auth passes — caller provides userId + code.
   * Body: { userId: string, code: string }
   */
  app.post<{ Body: { userId: string; code: string } }>(
    "/mfa/validate",
    {
      preHandler: mfaRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["userId", "code"],
          properties: {
            userId: { type: "string" },
            code: { type: "string", pattern: "^[0-9]{6}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, code } = request.body;

      const [user] = await db
        .select({ totpSecret: users.totpSecret, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user) {
        // Timing-safe: still do a dummy verify to prevent user enumeration
        verifyTotp("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", code);
        return reply.code(401).send({ error: "invalid" });
      }

      if (!user.mfaEnabled || !user.totpSecret) {
        return reply.code(400).send({ error: "mfa_not_enabled" });
      }

      const secret = decryptSecret(user.totpSecret);
      const valid = verifyTotp(secret, code);
      if (!valid) {
        return reply.code(401).send({ error: "invalid_code" });
      }

      return reply.send({ valid: true });
    },
  );

  /**
   * POST /mfa/disable
   *
   * Disable MFA. Requires a valid current TOTP code to prevent unauthorized disabling.
   * Body: { code: string }
   */
  app.post<{ Body: { code: string } }>(
    "/mfa/disable",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });

      const [user] = await db
        .select({ totpSecret: users.totpSecret, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user?.mfaEnabled || !user.totpSecret) {
        return reply.code(400).send({ error: "mfa_not_enabled" });
      }

      const secret = decryptSecret(user.totpSecret);
      const valid = verifyTotp(secret, request.body.code);
      if (!valid) {
        return reply.code(401).send({ error: "invalid_code" });
      }

      await db
        .update(users)
        .set({ mfaEnabled: false, totpSecret: null })
        .where(eq(users.id, userId));

      emitAuditEvent(
        { entityType: "user", entityId: userId, action: "mfa.disabled", actor: userId },
        app.log,
      );

      return reply.send({ mfaEnabled: false, message: "MFA disabled successfully" });
    },
  );
}
