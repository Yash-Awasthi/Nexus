// SPDX-License-Identifier: Apache-2.0
/**
 * User auth routes — register, login, token refresh, logout, profile.
 *
 * POST /api/v1/auth/register  — create account, return { accessToken, refreshToken, user }
 * POST /api/v1/auth/login     — authenticate, return { accessToken, refreshToken, user }
 * POST /api/v1/auth/refresh   — rotate the refresh token (body or nexus_refresh cookie)
 * POST /api/v1/auth/logout    — revoke refresh token
 * GET  /api/v1/auth/me        — return authenticated user profile
 * PATCH /api/v1/auth/me       — update name / email
 *
 * Security:
 *   Passwords — scrypt (N=32768, r=8, p=1) — NIST SP 800-132 compliant.
 *   Access tokens — HS256 or RS256 JWT (NEXUS_JWT_ALG, §14.1), 15-minute expiry.
 *   Brute-force — failed logins lock the email|ip key with exponential backoff (§14.3).
 *   Refresh tokens — 32-byte cryptographically random, SHA-256 hashed before storage.
 *   Refresh rotation — each refresh revokes the previous token (no re-use).
 *   Timing-safe compares everywhere (timingSafeEqual).
 */

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

import { db } from "@nexus/db";
import {
  users,
  refreshTokens,
  passwordResetTokens,
  emailVerificationTokens,
} from "@nexus/db/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.ts";
import {
  accountLocked,
  firstLockRefusal,
  assertLoginAllowed,
  loginThrottleKey,
  recordAccountFailure,
  recordLoginFailure,
  recordLoginSuccess,
} from "../lib/auth-hardening.ts";
import { sha256hex } from "../lib/crypto-utils.ts";
import { ACCESS_TOKEN_TTL_SEC, issueAccessToken } from "../lib/issue-access-token.ts";
import { appLink, sendMail } from "../lib/mailer.ts";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.ts";
import { emitReaction } from "../lib/reactions.ts";
import { securityEvent } from "../lib/security-events.ts";
import {
  endAllSessions,
  endSession,
  liveSessions,
  revokeSession,
} from "../lib/session-revocation.ts";
import { getSecurityKV } from "../lib/shared-kv.ts";
import { refreshCookie, setRefreshCookie } from "../lib/sign-in-finish.ts";
import { jwtClaims, requireAuthWithTier } from "../middleware/auth.ts";

import { acceptLoginCode, acceptRecoveryCode } from "./mfa.ts";

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
// OpenSSL default maxmem (32 MB) is below scrypt's 128*N*r usage (~32MB+) and
// throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Raise the cap to 128 MB.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = (await scrypt(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
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
      maxmem: SCRYPT_MAXMEM,
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

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

interface RotatedMark {
  userId: string;
  at: number;
}
// Access-token issuance (TTL, RS256/HS256 selection, role mapping) lives in
// lib/issue-access-token.ts — shared with the OAuth/OIDC/SAML SSO routes so
// NEXUS_JWT_ALG is honored everywhere (§14.1).

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
// Limits/windows are env-configurable (AUTH_*_RATE_LIMIT / AUTH_*_RATE_WINDOW_MS)
// so operators can tune or temporarily raise them without code changes;
// defaults stay at brute-force-safe values.

function authLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 10 login attempts per 15 min — standard brute-force protection
const loginRateLimit = makeRateLimitPreHandler({
  limit: authLimit("AUTH_LOGIN_RATE_LIMIT", 10),
  windowMs: authLimit("AUTH_LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
  keyPrefix: "auth:login",
});

// 5 registrations per hour — prevents account farming
const registerRateLimit = makeRateLimitPreHandler({
  limit: authLimit("AUTH_REGISTER_RATE_LIMIT", 5),
  windowMs: authLimit("AUTH_REGISTER_RATE_WINDOW_MS", 60 * 60 * 1000),
  keyPrefix: "auth:register",
});

// 3 reset requests per hour — prevents token-spam / inbox flooding
const forgotPasswordRateLimit = makeRateLimitPreHandler({
  limit: authLimit("AUTH_FORGOT_RATE_LIMIT", 3),
  windowMs: authLimit("AUTH_FORGOT_RATE_WINDOW_MS", 60 * 60 * 1000),
  keyPrefix: "auth:forgot",
});

export async function authUsersRoutes(app: FastifyInstance): Promise<void> {
  const jwtSecret = (): string => {
    const s = process.env.NEXUS_JWT_SECRET;
    if (!s) throw new Error("NEXUS_JWT_SECRET is not set");
    return s;
  };

  /** A new refresh-token row and an access token bound to it by `sid`. */
  const startSession = async (
    user: { id: string; role: string; tier: string },
    userAgent: string | null | undefined,
  ): Promise<{ accessToken: string; rawRefresh: string }> => {
    const rawRefresh = generateRefreshToken();
    const [row] = await db
      .insert(refreshTokens)
      .values({
        userId: user.id,
        tokenHash: sha256hex(rawRefresh),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: userAgent ?? null,
      })
      .returning({ id: refreshTokens.id });
    const { accessToken } = issueAccessToken(user.id, user.role, user.tier, jwtSecret(), row?.id);
    return { accessToken, rawRefresh };
  };

  // A rotated-away refresh token coming back later was copied, so every session ends;
  // one coming back within the grace window is two tabs refreshing at once.
  const endSessionsOnReplay = async (tokenHash: string): Promise<void> => {
    const mark = await getSecurityKV()
      .get<RotatedMark>(`auth:rotated:${tokenHash}`)
      .catch(() => undefined);
    const grace = Number(process.env.NEXUS_REFRESH_REUSE_GRACE_MS ?? 30_000);
    if (!mark || Date.now() - mark.at <= grace) return;
    await endAllSessions(mark.userId);
    emitAuditEvent(
      {
        entityType: "user",
        entityId: mark.userId,
        action: "auth.refresh_token_replayed",
        actor: mark.userId,
      },
      app.log,
    );
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
    app.post("/auth/sessions/revoke-all", notConfigured);
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

      // The desktop app has one local user and no other way to reach the admin
      // pages; a cloud deploy must never hand ownership to whoever signs up first.
      const firstDesktopUser =
        process.env.NEXUS_DESKTOP === "1" &&
        (await db.select({ id: users.id }).from(users).limit(1)).length === 0;

      const [user] = await db
        .insert(users)
        .values({
          email: normalEmail,
          passwordHash,
          name: name?.trim() ?? null,
          role: firstDesktopUser ? "owner" : "member",
          tier: "free",
        })
        .returning();

      if (!user) return reply.code(500).send({ error: "insert_failed" });

      const { accessToken, rawRefresh } = await startSession(user, request.headers["user-agent"]);

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
      setRefreshCookie(request, reply, rawRefresh);
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
    Body: { email: string; password: string; code?: string };
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
            code: { type: "string", maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password, code } = request.body;
      const normalEmail = email.trim().toLowerCase();

      // Always do scrypt work to prevent user-enumeration via timing
      const DUMMY_HASH = "scrypt$" + "0".repeat(64) + "$" + "0".repeat(128);

      // Brute-force backoff (§14.3) — checked BEFORE credential work so a locked
      // key is never billed scrypt cycles, and incremented on each failure.
      const throttleKey = loginThrottleKey(normalEmail, request.ip);
      assertLoginAllowed(throttleKey);
      if (await accountLocked(normalEmail)) {
        const [locked] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, normalEmail), isNull(users.deletedAt)))
          .limit(1);
        // Once per window: the counter has just crossed the line when this is the first refusal.
        if (locked && (await firstLockRefusal(normalEmail)))
          await securityEvent(locked.id, "signin.locked", {}, app.log);
        return reply.code(429).send({
          error: "too_many_attempts",
          message: "Too many failed sign-ins; try again later",
        });
      }

      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.email, normalEmail), isNull(users.deletedAt)))
        .limit(1);

      const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
      const valid = await verifyPassword(password, hashToVerify);

      if (!user || !valid) {
        recordLoginFailure(throttleKey);
        await recordAccountFailure(normalEmail);
        return reply
          .code(401)
          .send({ error: "invalid_credentials", message: "Invalid email or password" });
      }

      if (user.mfaEnabled && user.totpSecret) {
        if (!code) {
          return reply
            .code(401)
            .send({ error: "mfa_required", message: "Enter the code from your authenticator app" });
        }
        const entered = code.trim();
        const recoveryLeft = /^[0-9]{6}$/.test(entered)
          ? null
          : await acceptRecoveryCode(user.id, entered);
        if (recoveryLeft !== null) {
          await securityEvent(user.id, "mfa.recovery_used", {
            message: `${recoveryLeft} recovery codes are left.`,
          });
        } else if (!(await acceptLoginCode(user.id, user.totpSecret, entered))) {
          recordLoginFailure(throttleKey);
          await recordAccountFailure(normalEmail);
          return reply
            .code(401)
            .send({ error: "invalid_mfa_code", message: "That authenticator code is not valid" });
        }
      }

      recordLoginSuccess(throttleKey);
      emitReaction(user.id, "user.login", { at: new Date().toISOString() });

      const agent = request.headers["user-agent"] ?? null;
      const known = await db
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, user.id),
            agent === null ? isNull(refreshTokens.userAgent) : eq(refreshTokens.userAgent, agent),
          ),
        )
        .limit(1);
      const { accessToken, rawRefresh } = await startSession(user, agent);
      if (known.length === 0) {
        await securityEvent(user.id, "signin.new", {
          message: `From ${agent ?? "an unknown client"} at ${request.ip}.`,
        });
      }

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

      setRefreshCookie(request, reply, rawRefresh);
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
    Body: { refreshToken?: string } | undefined;
  }>(
    "/auth/refresh",
    {
      schema: {
        body: {
          type: "object",
          properties: { refreshToken: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const fromBody = request.body?.refreshToken;
      const rawToken = fromBody ?? refreshCookie(request);
      if (!rawToken) {
        return reply.code(401).send({
          error: "invalid_refresh_token",
          message: "Refresh token is invalid, expired, or already used",
        });
      }
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
        await endSessionsOnReplay(tokenHash);
        return reply.code(401).send({
          error: "invalid_refresh_token",
          message: "Refresh token is invalid, expired, or already used",
        });
      }

      // Only the request that revokes the row may rotate it; a concurrent one reuses nothing.
      const revoked = await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.id, stored.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (revoked.length === 0) {
        return reply.code(401).send({
          error: "invalid_refresh_token",
          message: "Refresh token is invalid, expired, or already used",
        });
      }
      await getSecurityKV().set<RotatedMark>(
        `auth:rotated:${tokenHash}`,
        { userId: stored.userId, at: Date.now() },
        REFRESH_TOKEN_TTL_MS,
      );

      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, stored.userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user) {
        return reply.code(401).send({ error: "user_not_found" });
      }

      const { accessToken: newAccessToken, rawRefresh: newRawRefresh } = await startSession(
        user,
        stored.userAgent,
      );

      setRefreshCookie(request, reply, newRawRefresh);
      return reply.send({
        accessToken: newAccessToken,
        // A cookie-held token stays out of the body, where page scripts could read it.
        ...(fromBody ? { refreshToken: newRawRefresh } : {}),
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
    Body: { refreshToken?: string } | undefined;
  }>(
    "/auth/logout",
    {
      schema: {
        body: {
          type: "object",
          properties: { refreshToken: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const rawToken = request.body?.refreshToken ?? refreshCookie(request);
      if (rawToken) {
        const ended = await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(refreshTokens.tokenHash, sha256hex(rawToken)), isNull(refreshTokens.revokedAt)),
          )
          .returning({ id: refreshTokens.id });
        for (const { id } of ended) await revokeSession(id);
      }
      setRefreshCookie(request, reply, null);
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
  app.get("/auth/me", { preHandler: requireAuthWithTier }, async (request, reply) => {
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
   * Email change needs the current password and marks emailVerified = false.
   */
  app.patch<{
    Body: { name?: string; email?: string; currentPassword?: string };
  }>(
    "/auth/me",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 100 },
            email: { type: "string", format: "email", maxLength: 320 },
            currentPassword: { type: "string", maxLength: 128 },
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
      let previousEmail: string | undefined;
      if (request.body.email !== undefined) {
        const normalEmail = request.body.email.trim().toLowerCase();
        // The email receives reset links, so a stolen session alone must not be able to move it.
        const [me] = await db
          .select({ email: users.email, passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!me) return reply.code(404).send({ error: "user_not_found" });
        const currentPassword = request.body.currentPassword;
        if (!me.passwordHash || !currentPassword) {
          return reply.code(400).send({
            error: "current_password_required",
            message: "Changing the sign-in email needs the current password",
          });
        }
        if (
          (await accountLocked(me.email)) ||
          !(await verifyPassword(currentPassword, me.passwordHash))
        ) {
          await recordAccountFailure(me.email);
          return reply.code(401).send({ error: "invalid_credentials" });
        }
        previousEmail = me.email;
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
      if (updates.email) {
        await securityEvent(userId, "email.changed", {
          message: `It is now ${updates.email}.`,
          ...(previousEmail ? { mailTo: previousEmail } : {}),
        });
      }
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
   * The link goes out by email (lib/mailer.ts) when mail is configured; outside
   * production the response also carries the token so tests need no inbox.
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

        app.log.info({ userId: user.id }, "password-reset-token-issued");
        const link = appLink(`/reset-password?token=${rawToken}`);
        // Not awaited: a slower answer for real addresses would reveal which ones exist.
        if (link)
          void sendMail(
            {
              to: user.email,
              subject: "Reset your Nexus password",
              text:
                `Someone asked to reset the password for this Nexus account.\n\n` +
                `Choose a new password within an hour: ${link}\n\n` +
                `If it wasn't you, ignore this message; your password stays the same.`,
            },
            app.log,
          );

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

      // Only the request that marks the token used may redeem it.
      const claimed = await db
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(and(eq(passwordResetTokens.id, stored.id), isNull(passwordResetTokens.usedAt)))
        .returning({ id: passwordResetTokens.id });
      if (claimed.length === 0) {
        return reply.code(400).send({
          error: "invalid_reset_token",
          message: "Reset token is invalid, expired, or already used",
        });
      }

      const newPasswordHash = await hashPassword(password);

      await db.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, user.id));

      await endAllSessions(user.id);
      await securityEvent(user.id, "password.changed", {
        message: "Every session was signed out.",
      });

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
   * for the currently authenticated user, marking the one making the request.
   * Does not return token hashes.
   */
  app.get("/auth/sessions", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });

    const { sid } = jwtClaims(request.headers.authorization);
    const sessions = await liveSessions(userId);
    return reply.send({
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent ?? null,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === sid,
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
  }>("/auth/sessions/:id", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });

    if (!(await endSession(userId, request.params.id))) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    return reply.code(204).send();
  });

  /** POST /auth/sessions/revoke-all — sign out everywhere, this device included. */
  app.post(
    "/auth/sessions/revoke-all",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });
      await endAllSessions(userId);
      await securityEvent(userId, "sessions.revoked", {}, app.log);
      setRefreshCookie(request, reply, null);
      return reply.code(204).send();
    },
  );

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
   * The link goes out by email when mail is configured; outside production the
   * response also carries the token.
   */
  app.post(
    "/auth/send-verification",
    { preHandler: [requireAuthWithTier, sendVerifyRateLimit] },
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

      app.log.info({ userId }, "email-verification-token-issued");
      const link = appLink(`/verify-email?token=${rawToken}`);
      if (link)
        await sendMail(
          {
            to: user.email,
            subject: "Confirm your email for Nexus",
            text: `Confirm this address for your Nexus account within a day: ${link}`,
          },
          app.log,
        );

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

      const claimed = await db
        .update(emailVerificationTokens)
        .set({ usedAt: now })
        .where(
          and(eq(emailVerificationTokens.id, stored.id), isNull(emailVerificationTokens.usedAt)),
        )
        .returning({ id: emailVerificationTokens.id });
      if (claimed.length === 0) {
        return reply.code(400).send({
          error: "invalid_verification_token",
          message: "Token is invalid, expired, or already used",
        });
      }

      // The token proves the address it was sent to; an email changed since then stays unverified.
      const verified = await db
        .update(users)
        .set({ emailVerified: true })
        .where(and(eq(users.id, stored.userId), eq(users.email, stored.email)))
        .returning({ id: users.id });
      if (verified.length === 0) {
        return reply.code(400).send({
          error: "invalid_verification_token",
          message: "Token is invalid, expired, or already used",
        });
      }

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
