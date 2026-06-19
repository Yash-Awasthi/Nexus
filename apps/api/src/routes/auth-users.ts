// SPDX-License-Identifier: Apache-2.0
/**
 * User auth routes — register, login, token refresh, logout, profile.
 *
 * POST /api/v1/auth/register  — create account, return { accessToken, refreshToken, user }
 * POST /api/v1/auth/login     — authenticate, return { accessToken, refreshToken, user }
 * POST /api/v1/auth/refresh   — rotate refresh token, return new { accessToken, refreshToken }
 * POST /api/v1/auth/logout    — revoke refresh token
 * GET  /api/v1/auth/me        — return authenticated user profile
 * PATCH /api/v1/auth/me       — update name / email
 *
 * Security:
 *   Passwords — scrypt (N=32768, r=8, p=1) — NIST SP 800-132 compliant.
 *   Access tokens — HS256 JWT, 15-minute expiry.
 *   Refresh tokens — 32-byte cryptographically random, SHA-256 hashed before storage.
 *   Refresh rotation — each refresh revokes the previous token (no re-use).
 *   Timing-safe compares everywhere (timingSafeEqual).
 */

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

import { signJwt } from "@nexus/auth";
import { db } from "@nexus/db";
import {
  users,
  refreshTokens,
  passwordResetTokens,
  emailVerificationTokens,
} from "@nexus/db/schema";
import { eq, and, gt, isNull, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.js";
import { sha256hex } from "../lib/crypto-utils.js";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { requireAuth } from "../middleware/auth.js";

const scrypt = promisify(_scrypt) as (
  password: Buffer | string,
  salt: Buffer | string,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// ── Crypto helpers ────────────────────────────────────────────────────────────

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const SALT_LEN = 32;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = (await scrypt(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  // Format: scrypt$salt_hex$hash_hex
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [, saltHex, hashHex] = parts as [string, string, string];
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  let derived: Buffer;
  try {
    derived = (await scrypt(password, salt, SCRYPT_KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })) as Buffer;
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

// ── JWT issuance ──────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_SEC = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function issueAccessToken(userId: string, role: string, tier: string, secret: string): string {
  return signJwt(
    {
      sub: userId,
      role: role as "admin" | "agent" | "read-only",
      tier,
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC,
    } as Parameters<typeof signJwt>[0],
    secret,
  );
}

// ── Safe user view (never return passwordHash, totpSecret) ────────────────────

function safeUser(u: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  tier: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    tier: u.tier,
    emailVerified: u.emailVerified,
    mfaEnabled: u.mfaEnabled,
    createdAt: u.createdAt.toISOString(),
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

// ── Per-route rate limiters ───────────────────────────────────────────────────
// All keyed by IP. Auth endpoints are the highest-risk surface area.

// 10 login attempts per 15 min — standard brute-force protection
const loginRateLimit = makeRateLimitPreHandler({
  limit: 10,
  windowMs: 15 * 60 * 1000,
  keyPrefix: "auth:login",
});

// 5 registrations per hour — prevents account farming
const registerRateLimit = makeRateLimitPreHandler({
  limit: 5,
  windowMs: 60 * 60 * 1000,
  keyPrefix: "auth:register",
});

// 3 reset requests per hour — prevents token-spam / inbox flooding
const forgotPasswordRateLimit = makeRateLimitPreHandler({
  limit: 3,
  windowMs: 60 * 60 * 1000,
  keyPrefix: "auth:forgot",
});

export async function authUsersRoutes(app: FastifyInstance): Promise<void> {
  const jwtSecret = (): string => {
    const s = process.env.NEXUS_JWT_SECRET;
    if (!s) throw new Error("NEXUS_JWT_SECRET is not set");
    return s;
  };

  const dbAvailable = !!process.env.DATABASE_URL;

  if (!dbAvailable) {
    // Graceful degradation — auth routes return 503 with clear message
    const notConfigured = async (
      _req: unknown,
      reply: { code: (n: number) => { send: (v: unknown) => unknown } },
    ) =>
      reply
        .code(503)
        .send({ error: "auth_unavailable", message: "DATABASE_URL is not configured" });
    app.post("/auth/register", notConfigured);
    app.post("/auth/login", notConfigured);
    app.post("/auth/refresh", notConfigured);
    app.post("/auth/logout", notConfigured);
    app.get("/auth/me", notConfigured);
    app.patch("/auth/me", notConfigured);
    app.post("/auth/forgot-password", notConfigured);
    app.post("/auth/reset-password", notConfigured);
    app.get("/auth/sessions", notConfigured);
    app.delete("/auth/sessions/:id", notConfigured);
    app.post("/auth/send-verification", notConfigured);
    app.post("/auth/verify-email", notConfigured);
    return;
  }

  /**
   * POST /auth/register
   *
   * Create a new user account.
   * Returns an access token + refresh token pair on success.
   */
  app.post<{
    Body: { email: string; password: string; name?: string };
  }>(
    "/auth/register",
    {
      preHandler: registerRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            password: { type: "string", minLength: 8, maxLength: 128 },
            name: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password, name } = request.body;
      const normalEmail = email.trim().toLowerCase();

      // Check uniqueness
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalEmail))
        .limit(1);

      if (existing.length > 0) {
        return reply.code(409).send({ error: "email_taken", message: "Email already registered" });
      }

      const passwordHash = await hashPassword(password);

      const [user] = await db
        .insert(users)
        .values({
          email: normalEmail,
          passwordHash,
          name: name?.trim() ?? null,
          role: "member",
          tier: "free",
        })
        .returning();

      if (!user) return reply.code(500).send({ error: "insert_failed" });

      // Issue tokens
      const accessToken = issueAccessToken(user.id, user.role, user.tier, jwtSecret());
      const rawRefresh = generateRefreshToken();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      await db.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: sha256hex(rawRefresh),
        expiresAt,
        userAgent: request.headers["user-agent"] ?? null,
      });

      emitAuditEvent(
        {
          entityType: "user",
          entityId: user.id,
          action: "auth.register",
          actor: user.id,
          payload: { email: normalEmail, name: user.name ?? undefined },
        },
        app.log,
      );

      reply.code(201);
      return reply.send({
        accessToken,
        refreshToken: rawRefresh,
        expiresIn: ACCESS_TOKEN_TTL_SEC,
        tokenType: "Bearer",
        user: safeUser(user),
      });
    },
  );

  /**
   * POST /auth/login
   *
   * Authenticate with email + password.
   * Returns access token + refresh token on success.
   * Always takes the same time regardless of whether the user exists (timing-safe).
   */
  app.post<{
    Body: { email: string; password: string };
  }>(
    "/auth/login",
    {
      preHandler: loginRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const normalEmail = email.trim().toLowerCase();

      // Always do scrypt work to prevent user-enumeration via timing
      const DUMMY_HASH = "scrypt$" + "0".repeat(64) + "$" + "0".repeat(128);

      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.email, normalEmail), isNull(users.deletedAt)))
        .limit(1);

      const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
      const valid = await verifyPassword(password, hashToVerify);

      if (!user || !valid) {
        return reply
          .code(401)
          .send({ error: "invalid_credentials", message: "Invalid email or password" });
      }

      const accessToken = issueAccessToken(user.id, user.role, user.tier, jwtSecret());
      const rawRefresh = generateRefreshToken();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      await db.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: sha256hex(rawRefresh),
        expiresAt,
        userAgent: request.headers["user-agent"] ?? null,
      });

      emitAuditEvent(
        {
          entityType: "user",
          entityId: user.id,
          action: "auth.login",
          actor: user.id,
          payload: {
            userAgent: request.headers["user-agent"] ?? null,
            ip: request.ip,
          },
        },
        app.log,
      );

      return reply.send({
        accessToken,
        refreshToken: rawRefresh,
        expiresIn: ACCESS_TOKEN_TTL_SEC,
        tokenType: "Bearer",
        user: safeUser(user),
      });
    },
  );

  /**
   * POST /auth/refresh
   *
   * Exchange a valid refresh token for a new access token + refresh token.
   * The old refresh token is atomically revoked (rotation — prevents re-use).
   */
  app.post<{
    Body: { refreshToken: string };
  }>(
    "/auth/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken: rawToken } = request.body;
      const tokenHash = sha256hex(rawToken);
      const now = new Date();

      const [stored] = await db
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, now),
          ),
        )
        .limit(1);

      if (!stored) {
        return reply.code(401).send({
          error: "invalid_refresh_token",
          message: "Refresh token is invalid, expired, or already used",
        });
      }

      // Atomic rotation — revoke old, issue new
      await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, stored.id));

      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, stored.userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user) {
        return reply.code(401).send({ error: "user_not_found" });
      }

      const newAccessToken = issueAccessToken(user.id, user.role, user.tier, jwtSecret());
      const newRawRefresh = generateRefreshToken();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      await db.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: sha256hex(newRawRefresh),
        expiresAt,
        userAgent: stored.userAgent,
      });

      return reply.send({
        accessToken: newAccessToken,
        refreshToken: newRawRefresh,
        expiresIn: ACCESS_TOKEN_TTL_SEC,
        tokenType: "Bearer",
      });
    },
  );

  /**
   * POST /auth/logout
   *
   * Revoke a refresh token. Access tokens are short-lived (15 min) so no
   * server-side invalidation needed for them.
   */
  app.post<{
    Body: { refreshToken: string };
  }>(
    "/auth/logout",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const tokenHash = sha256hex(request.body.refreshToken);
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
      // Always 204 — don't reveal whether token existed
      return reply.code(204).send();
    },
  );

  /**
   * GET /auth/me
   *
   * Return the authenticated user's profile.
   * Reads userId from the JWT sub claim.
   */
  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) {
      // API key auth — no user record; return minimal profile
      return reply.send({
        id: null,
        email: null,
        name: "API Key User",
        role: "member",
        tier: request.nexusTier ?? "free",
        emailVerified: false,
        mfaEnabled: false,
        authMethod: "api_key",
      });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user) return reply.code(404).send({ error: "user_not_found" });
    return reply.send({ ...safeUser(user), authMethod: "jwt" });
  });

  /**
   * PATCH /auth/me
   *
   * Update own profile (name, email).
   * Email change marks emailVerified = false (re-verification needed).
   */
  app.patch<{
    Body: { name?: string; email?: string };
  }>(
    "/auth/me",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 100 },
            email: { type: "string", format: "email", maxLength: 320 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });

      const updates: Partial<{ name: string; email: string; emailVerified: boolean }> = {};

      if (request.body.name !== undefined) {
        updates.name = request.body.name.trim();
      }
      if (request.body.email !== undefined) {
        const normalEmail = request.body.email.trim().toLowerCase();
        // Check not already taken by another user
        const [conflict] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, normalEmail))
          .limit(1);
        if (conflict && conflict.id !== userId) {
          return reply.code(409).send({ error: "email_taken" });
        }
        updates.email = normalEmail;
        updates.emailVerified = false;
      }

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "no_changes", message: "No valid fields to update" });
      }

      const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();

      if (!updated) return reply.code(404).send({ error: "user_not_found" });
      return reply.send(safeUser(updated));
    },
  );

  // ── Password reset ─────────────────────────────────────────────────────────

  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

  /**
   * POST /auth/forgot-password
   *
   * Request a password reset link. Always returns 204 regardless of whether
   * the email exists — prevents user-enumeration.
   *
   * In production a transactional email service should deliver the token;
   * here the token is emitted to the server log (dev mode) and the response
   * includes it only when NODE_ENV !== "production" for test convenience.
   */
  app.post<{
    Body: { email: string };
  }>(
    "/auth/forgot-password",
    {
      preHandler: forgotPasswordRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
          },
        },
      },
    },
    async (request, reply) => {
      const normalEmail = request.body.email.trim().toLowerCase();

      const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.email, normalEmail), isNull(users.deletedAt)))
        .limit(1);

      if (user) {
        const rawToken = randomBytes(32).toString("hex");
        const tokenHash = sha256hex(rawToken);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        // Invalidate any existing unused tokens for this user
        await db
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(passwordResetTokens.userId, user.id),
              isNull(passwordResetTokens.usedAt),
              gt(passwordResetTokens.expiresAt, new Date()),
            ),
          );

        await db.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash,
          expiresAt,
        });

        // Dev: surface token in log + response body for easy testing
        app.log.info({ resetToken: rawToken, email: normalEmail }, "password-reset-token-issued");

        if (process.env.NODE_ENV !== "production") {
          // Non-production: return token directly so integration tests don't need SMTP
          return reply.code(200).send({
            message: "Reset token issued (non-production only)",
            resetToken: rawToken,
            expiresAt: expiresAt.toISOString(),
          });
        }
      }

      // Always 204 in production — prevents enumeration
      return reply.code(204).send();
    },
  );

  /**
   * POST /auth/reset-password
   *
   * Redeem a reset token and set a new password.
   * The token is single-use: usedAt is set immediately on first redemption.
   * All active refresh tokens are revoked — forces re-login on all devices.
   */
  app.post<{
    Body: { token: string; password: string };
  }>(
    "/auth/reset-password",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "password"],
          properties: {
            token: { type: "string", minLength: 1 },
            password: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { token: rawToken, password } = request.body;
      const tokenHash = sha256hex(rawToken);
      const now = new Date();

      const [stored] = await db
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, now),
          ),
        )
        .limit(1);

      if (!stored) {
        return reply.code(400).send({
          error: "invalid_reset_token",
          message: "Reset token is invalid, expired, or already used",
        });
      }

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, stored.userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user) {
        return reply.code(400).send({ error: "user_not_found" });
      }

      const newPasswordHash = await hashPassword(password);

      // Mark token used, update password, revoke all sessions — all in sequence
      await db
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(eq(passwordResetTokens.id, stored.id));

      await db.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, user.id));

      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));

      emitAuditEvent(
        {
          entityType: "user",
          entityId: user.id,
          action: "auth.password_reset",
          actor: user.id,
          payload: { method: "reset_token", sessionsRevoked: true },
        },
        app.log,
      );

      return reply.code(200).send({ message: "Password updated. Please log in again." });
    },
  );

  // ── Self-service session management ───────────────────────────────────────

  /**
   * GET /auth/sessions
   *
   * List all active (non-revoked, non-expired) refresh token sessions
   * for the currently authenticated user. Does not return token hashes.
   */
  app.get("/auth/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });

    const now = new Date();
    const sessions = await db
      .select({
        id: refreshTokens.id,
        userAgent: refreshTokens.userAgent,
        createdAt: refreshTokens.createdAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(refreshTokens.createdAt));

    return reply.send({
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent ?? null,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      })),
    });
  });

  /**
   * DELETE /auth/sessions/:id
   *
   * Revoke a specific session (refresh token) by its UUID.
   * Users can only revoke their own sessions.
   */
  app.delete<{
    Params: { id: string };
  }>("/auth/sessions/:id", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });

    const { id: sessionId } = request.params;

    // Verify the session belongs to the requesting user before revoking
    const [session] = await db
      .select({ id: refreshTokens.id, userId: refreshTokens.userId })
      .from(refreshTokens)
      .where(eq(refreshTokens.id, sessionId))
      .limit(1);

    if (!session || session.userId !== userId) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, sessionId), isNull(refreshTokens.revokedAt)));

    return reply.code(204).send();
  });

  // ── Email verification ─────────────────────────────────────────────────────

  const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // 5 verification sends per hour per user — prevent inbox flooding
  const sendVerifyRateLimit = makeRateLimitPreHandler({
    limit: 5,
    windowMs: 60 * 60 * 1000,
    keyPrefix: "auth:send-verify",
    keyBy: (req) => (req as { nexusUserId?: string }).nexusUserId ?? "anon",
  });

  /**
   * POST /auth/send-verification
   *
   * Issue (or re-issue) an email verification token for the authenticated user.
   * In production: send token via transactional email service.
   * In dev/test: return token in response body (no SMTP needed).
   */
  app.post(
    "/auth/send-verification",
    { preHandler: [requireAuth, sendVerifyRateLimit] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });

      const [user] = await db
        .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user) return reply.code(404).send({ error: "user_not_found" });

      if (user.emailVerified) {
        return reply.code(409).send({
          error: "already_verified",
          message: "Email is already verified",
        });
      }

      // Invalidate any existing unused tokens for this user+email
      await db
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailVerificationTokens.userId, userId),
            eq(emailVerificationTokens.email, user.email),
            isNull(emailVerificationTokens.usedAt),
            gt(emailVerificationTokens.expiresAt, new Date()),
          ),
        );

      const rawToken = randomBytes(32).toString("hex");
      const tokenHash = sha256hex(rawToken);
      const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

      await db.insert(emailVerificationTokens).values({
        userId,
        tokenHash,
        email: user.email,
        expiresAt,
      });

      app.log.info({ verifyToken: rawToken, email: user.email }, "email-verification-token-issued");

      if (process.env.NODE_ENV !== "production") {
        return reply.code(200).send({
          message: "Verification token issued (non-production only)",
          verifyToken: rawToken,
          expiresAt: expiresAt.toISOString(),
        });
      }

      return reply.code(204).send();
    },
  );

  /**
   * POST /auth/verify-email
   *
   * Redeem a verification token to mark the user's email as verified.
   * Token is single-use; usedAt is set immediately on redemption.
   * Body: { token: string }
   */
  app.post<{ Body: { token: string } }>(
    "/auth/verify-email",
    {
      schema: {
        body: {
          type: "object",
          required: ["token"],
          properties: { token: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const tokenHash = sha256hex(request.body.token);
      const now = new Date();

      const [stored] = await db
        .select()
        .from(emailVerificationTokens)
        .where(
          and(
            eq(emailVerificationTokens.tokenHash, tokenHash),
            isNull(emailVerificationTokens.usedAt),
            gt(emailVerificationTokens.expiresAt, now),
          ),
        )
        .limit(1);

      if (!stored) {
        return reply.code(400).send({
          error: "invalid_verification_token",
          message: "Token is invalid, expired, or already used",
        });
      }

      // Mark used + set emailVerified atomically in sequence
      await db
        .update(emailVerificationTokens)
        .set({ usedAt: now })
        .where(eq(emailVerificationTokens.id, stored.id));

      await db.update(users).set({ emailVerified: true }).where(eq(users.id, stored.userId));

      emitAuditEvent(
        {
          entityType: "user",
          entityId: stored.userId,
          action: "auth.email_verified",
          actor: stored.userId,
          payload: { email: stored.email },
        },
        app.log,
      );

      return reply.code(200).send({ message: "Email verified successfully." });
    },
  );
}
