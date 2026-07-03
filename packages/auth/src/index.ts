// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/auth — authentication and authorisation primitives.
 *
 * Provides framework-agnostic auth logic that apps/api, apps/worker,
 * and services/ingest all consume. Eliminates duplicated auth code.
 *
 * Exports:
 *   verifyApiKey(token, expected)  — constant-time API key check
 *   verifyJwt(token, secret)       — HS256 JWT verify + decode
 *   extractBearerToken(header)     — parse Authorization: Bearer <token>
 *   AuthError                      — typed error with code + status
 *
 *   Fastify adapter:  makeFastifyAuthHook(config)
 *   Generic adapter:  makeAuthMiddleware(config)
 *
 * JWT format (HS256):
 *   { sub: string, role: "admin"|"agent"|"read-only", iat: number, exp: number }
 */

import { createHmac, createSign, createVerify, timingSafeEqual } from "node:crypto";

// ── Error ─────────────────────────────────────────────────────────────────────

export type AuthErrorCode =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "EXPIRED_TOKEN"
  | "INSUFFICIENT_ROLE"
  | "REVOKED_TOKEN"
  | "RATE_LIMITED";

/** Auth error. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly httpStatus: number;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.httpStatus = AUTH_ERROR_STATUS[code];
  }
}

const AUTH_ERROR_STATUS: Record<AuthErrorCode, number> = {
  MISSING_TOKEN: 401,
  INVALID_TOKEN: 401,
  EXPIRED_TOKEN: 401,
  REVOKED_TOKEN: 401,
  INSUFFICIENT_ROLE: 403,
  RATE_LIMITED: 429,
};

// ── Token types ───────────────────────────────────────────────────────────────

export type NexusRole = "admin" | "agent" | "read-only";

/** Nexus token payload interface definition. */
export interface NexusTokenPayload {
  sub: string;
  role: NexusRole;
  iat: number;
  exp: number;
  /** Optional — agent-specific capability set */
  capabilities?: string[];
  /** Optional — unique token id, enables per-token revocation (see SessionRevocationRegistry). */
  jti?: string;
}

// ── extractBearerToken ────────────────────────────────────────────────────────

export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("MISSING_TOKEN", "Authorization: Bearer <token> header required");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new AuthError("MISSING_TOKEN", "Bearer token is empty");
  return token;
}

// ── verifyApiKey ──────────────────────────────────────────────────────────────

/**
 * Constant-time API key comparison.
 * Returns true if token matches expected; throws AuthError otherwise.
 */
export function verifyApiKey(token: string, expected: string): true {
  if (!token || !expected) throw new AuthError("INVALID_TOKEN", "Invalid API key");

  const a = Buffer.from(token.padEnd(64, "\0"), "utf8");
  const b = Buffer.from(expected.padEnd(64, "\0"), "utf8");

  // Ensure same length for timingSafeEqual
  const len = Math.max(a.length, b.length);
  const aBuf = Buffer.alloc(len);
  const bBuf = Buffer.alloc(len);
  a.copy(aBuf);
  b.copy(bBuf);

  if (!timingSafeEqual(aBuf, bBuf) || token !== expected) {
    throw new AuthError("INVALID_TOKEN", "Invalid API key");
  }
  return true;
}

// ── JWT (HS256, no external deps) ─────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Sign a NexusTokenPayload and return a compact JWT string.
 * Uses HMAC-SHA256 (HS256).
 */
export function signJwt(payload: Omit<NexusTokenPayload, "iat">, secret: string): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64UrlEncode(
    Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })),
  );
  const sig = base64UrlEncode(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

/**
 * Verify and decode a compact JWT string.
 * Throws AuthError on invalid signature, expiry, or malformed token.
 */
export function verifyJwt(token: string, secret: string): NexusTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("INVALID_TOKEN", "Malformed JWT");

  const [header, body, sig] = parts as [string, string, string];
  // lgtm[js/insufficient-password-hash] — HMAC-SHA256 here is JWT *signature* computation,
  // not password storage. Passwords are never passed to this function.
  const expectedSig = base64UrlEncode(
    createHmac("sha256", secret).update(`${header}.${body}`).digest(), // lgtm[js/insufficient-password-hash]
  );

  // Timing-safe signature comparison
  const sigBuf = Buffer.from(sig, "base64");
  const expectedBuf = Buffer.from(expectedSig, "base64");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new AuthError("INVALID_TOKEN", "JWT signature verification failed");
  }

  let payload: NexusTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString("utf8")) as NexusTokenPayload;
  } catch {
    throw new AuthError("INVALID_TOKEN", "JWT payload is not valid JSON");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new AuthError(
      "EXPIRED_TOKEN",
      `JWT expired at ${new Date(payload.exp * 1000).toISOString()}`,
    );
  }

  return payload;
}

// ── JWT (RS256, asymmetric — multi-service, §14) ──────────────────────────────
// RS256 signs with a PRIVATE key and verifies with the matching PUBLIC key, so a
// downstream service can validate tokens minted by the auth service WITHOUT
// holding a secret that would let it forge them — the multi-tenant hardening win
// over the shared-secret HS256 path above. Same base64url + payload shape; only
// the header `alg` and the signature primitive differ.

/**
 * Sign a NexusTokenPayload with an RSA private key (PEM) → compact RS256 JWT.
 * Verify the result with {@link verifyJwtRS256} and the matching public key.
 */
export function signJwtRS256(
  payload: Omit<NexusTokenPayload, "iat">,
  privateKeyPem: string,
): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = base64UrlEncode(
    Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })),
  );
  const signingInput = `${header}.${body}`;
  const sig = base64UrlEncode(createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem));
  return `${signingInput}.${sig}`;
}

/**
 * Verify and decode an RS256 JWT with an RSA public key (PEM).
 * Throws AuthError on a wrong `alg`, bad signature, expiry, or malformed token.
 * The `alg` header is pinned to `RS256` to defend against algorithm-confusion
 * (e.g. an attacker swapping in `alg:"none"` or an HS256 forgery keyed on the
 * public key).
 */
export function verifyJwtRS256(token: string, publicKeyPem: string): NexusTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("INVALID_TOKEN", "Malformed JWT");
  const [header, body, sig] = parts as [string, string, string];

  let alg: unknown;
  try {
    alg = (JSON.parse(base64UrlDecode(header).toString("utf8")) as { alg?: unknown }).alg;
  } catch {
    throw new AuthError("INVALID_TOKEN", "JWT header is not valid JSON");
  }
  if (alg !== "RS256") {
    throw new AuthError("INVALID_TOKEN", `Unexpected JWT alg "${String(alg)}" — RS256 required`);
  }

  const ok = createVerify("RSA-SHA256")
    .update(`${header}.${body}`)
    .verify(publicKeyPem, base64UrlDecode(sig));
  if (!ok) {
    throw new AuthError("INVALID_TOKEN", "JWT signature verification failed");
  }

  let payload: NexusTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString("utf8")) as NexusTokenPayload;
  } catch {
    throw new AuthError("INVALID_TOKEN", "JWT payload is not valid JSON");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new AuthError(
      "EXPIRED_TOKEN",
      `JWT expired at ${new Date(payload.exp * 1000).toISOString()}`,
    );
  }

  return payload;
}

// ── Auth config ───────────────────────────────────────────────────────────────

export interface AuthConfig {
  /**
   * API key checked against Authorization: Bearer <key>.
   * If set alongside jwtSecret, the middleware accepts EITHER a valid API key
   * OR a valid JWT.
   */
  apiKey?: string;
  /** JWT secret for HS256 verification */
  jwtSecret?: string;
  /** Minimum required role. Defaults to "read-only" (any valid token). */
  requiredRole?: NexusRole;
  /**
   * When true, auth is skipped entirely (useful for local dev).
   * Defaults to false.
   */
  disabled?: boolean;
}

const ROLE_RANK: Record<NexusRole, number> = { "read-only": 0, agent: 1, admin: 2 };

function hasRequiredRole(actual: NexusRole, required: NexusRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ── Generic middleware ────────────────────────────────────────────────────────

export interface AuthResult {
  authenticated: boolean;
  subject?: string;
  role?: NexusRole;
  /** How the request was authenticated */
  method?: "api-key" | "jwt";
}

/**
 * Verify a request's Authorization header against the provided config.
 * Returns an AuthResult — throws AuthError on failure.
 */
export function authenticate(authHeader: string | undefined, config: AuthConfig): AuthResult {
  if (config.disabled) {
    return { authenticated: true, method: "api-key", subject: "dev", role: "admin" };
  }

  if (!config.apiKey && !config.jwtSecret) {
    throw new Error("@nexus/auth: at least one of apiKey or jwtSecret must be configured");
  }

  const token = extractBearerToken(authHeader);
  const requiredRole: NexusRole = config.requiredRole ?? "read-only";

  // Try API key first
  if (config.apiKey) {
    try {
      verifyApiKey(token, config.apiKey);
      return { authenticated: true, subject: "api-key", role: "admin", method: "api-key" };
    } catch {
      // Not an API key — fall through to JWT
    }
  }

  // Try JWT
  if (config.jwtSecret) {
    const payload = verifyJwt(token, config.jwtSecret);
    if (!hasRequiredRole(payload.role, requiredRole)) {
      throw new AuthError(
        "INSUFFICIENT_ROLE",
        `Role "${payload.role}" insufficient — "${requiredRole}" required`,
      );
    }
    return {
      authenticated: true,
      subject: payload.sub,
      role: payload.role,
      method: "jwt",
    };
  }

  throw new AuthError("INVALID_TOKEN", "Token did not match any configured auth method");
}

// ── Fastify adapter ───────────────────────────────────────────────────────────

export type FastifyAuthHookFn = (
  request: { headers: { authorization?: string } },
  reply: {
    code: (n: number) => { send: (body: unknown) => Promise<void> };
  },
) => Promise<void>;

/**
 * Returns a Fastify preHandler hook that enforces auth.
 *
 * Usage:
 *   const authHook = makeFastifyAuthHook({ apiKey: process.env.NEXUS_API_KEY });
 *   await app.register(async (api) => {
 *     api.addHook("preHandler", authHook);
 *     // ... protected routes
 *   });
 */
export function makeFastifyAuthHook(config: AuthConfig): FastifyAuthHookFn {
  return async (request, reply) => {
    try {
      authenticate(request.headers.authorization, config);
    } catch (err) {
      if (err instanceof AuthError) {
        await reply.code(err.httpStatus).send({ code: err.code, message: err.message });
      } else {
        await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Auth check failed" });
      }
    }
  };
}

// ── Brute-force backoff (§14.3) ───────────────────────────────────────────────
// Framework-agnostic failed-attempt throttle: exponential lockout keyed by an
// arbitrary identifier (compose it as `subject|ip` at the call site). The clock
// is injectable so lockout escalation is deterministically testable. The state
// is held in a plain Map — swap in a Redis-backed LoginThrottleStore later
// without touching callers.

/** A clock returning epoch milliseconds. Injected for deterministic tests. */
export type Clock = () => number;

/** Tuning for {@link LoginThrottle}. */
export interface LoginThrottleOptions {
  /** Failures tolerated before the first lockout. Default 5. */
  threshold?: number;
  /** Base lockout once the threshold is crossed, in ms. Default 1000. */
  baseLockoutMs?: number;
  /** Cap on any single lockout, in ms. Default 15 min. */
  maxLockoutMs?: number;
  /** Idle window after which an identifier's counter resets, in ms. Default 15 min. */
  windowMs?: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: Clock;
}

interface AttemptState {
  fails: number;
  /** Epoch ms until which the identifier is locked (0 = not locked). */
  lockedUntil: number;
  /** Epoch ms of the last recorded failure (for idle-window reset). */
  lastFail: number;
}

/**
 * Exponential-backoff lockout for repeated auth failures.
 *
 *   throttle.assertNotLocked(id)  — throws RATE_LIMITED while locked.
 *   throttle.recordFailure(id)    — bump the counter; lock past the threshold.
 *   throttle.recordSuccess(id)    — clear the counter on a good login.
 *
 * Lockout after the Nth failure past `threshold` is
 * `min(baseLockoutMs * 2^(n-1), maxLockoutMs)`. An identifier idle longer than
 * `windowMs` starts fresh.
 */
export class LoginThrottle {
  private readonly threshold: number;
  private readonly baseLockoutMs: number;
  private readonly maxLockoutMs: number;
  private readonly windowMs: number;
  private readonly now: Clock;
  private readonly attempts = new Map<string, AttemptState>();

  constructor(opts: LoginThrottleOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.baseLockoutMs = opts.baseLockoutMs ?? 1_000;
    this.maxLockoutMs = opts.maxLockoutMs ?? 15 * 60_000;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** ms remaining on an active lockout for `id`, else 0. */
  lockedMsRemaining(id: string): number {
    const s = this.attempts.get(id);
    if (!s) return 0;
    const now = this.now();
    if (now - s.lastFail > this.windowMs) {
      this.attempts.delete(id);
      return 0;
    }
    return s.lockedUntil > now ? s.lockedUntil - now : 0;
  }

  /** Throw RATE_LIMITED if `id` is currently locked out. */
  assertNotLocked(id: string): void {
    const remaining = this.lockedMsRemaining(id);
    if (remaining > 0) {
      throw new AuthError(
        "RATE_LIMITED",
        `Too many attempts — retry in ${Math.ceil(remaining / 1000)}s`,
      );
    }
  }

  /** Record a failed attempt; returns the resulting lockout in ms (0 if none yet). */
  recordFailure(id: string): number {
    const now = this.now();
    let s = this.attempts.get(id);
    if (!s || now - s.lastFail > this.windowMs) {
      s = { fails: 0, lockedUntil: 0, lastFail: now };
      this.attempts.set(id, s);
    }
    s.fails += 1;
    s.lastFail = now;
    const over = s.fails - this.threshold;
    if (over >= 0) {
      const lockout = Math.min(this.baseLockoutMs * 2 ** over, this.maxLockoutMs);
      s.lockedUntil = now + lockout;
      return lockout;
    }
    return 0;
  }

  /** Clear all state for `id` after a successful auth. */
  recordSuccess(id: string): void {
    this.attempts.delete(id);
  }
}

// ── Session revocation (§14.3) ────────────────────────────────────────────────
// Two revocation modes, both O(1): a per-token `jti` denylist (log out one
// session) and a per-subject cutoff (log out every session issued before a
// timestamp — e.g. on password change). `assertNotRevoked` pairs with a verified
// payload after signature/expiry checks pass.

/** In-memory session-revocation registry. Swap for a Redis-backed store later. */
export class SessionRevocationRegistry {
  private readonly now: Clock;
  private readonly revokedJti = new Map<string, number>(); // jti → expiry epoch ms (for GC)
  private readonly subjectCutoff = new Map<string, number>(); // sub → revoke-iat-before (epoch s)

  constructor(opts: { now?: Clock } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Revoke a single token by its `jti`. `expSeconds` (the token's `exp`) lets the
   * entry be garbage-collected once the token would have expired anyway.
   */
  revokeJti(jti: string, expSeconds?: number): void {
    this.revokedJti.set(jti, expSeconds ? expSeconds * 1000 : this.now() + 24 * 3600_000);
  }

  /**
   * Revoke every token for `subject` issued at/before now — call on password
   * change or "log out everywhere". Tokens with `iat <= cutoff` are rejected.
   */
  revokeAllForSubject(subject: string): void {
    this.subjectCutoff.set(subject, Math.floor(this.now() / 1000));
  }

  /** True if the given verified payload has been revoked by either mechanism. */
  isRevoked(payload: Pick<NexusTokenPayload, "sub" | "iat" | "jti">): boolean {
    if (payload.jti !== undefined && this.revokedJti.has(payload.jti)) return true;
    const cutoff = this.subjectCutoff.get(payload.sub);
    return cutoff !== undefined && payload.iat <= cutoff;
  }

  /** Throw REVOKED_TOKEN if the payload has been revoked. */
  assertNotRevoked(payload: Pick<NexusTokenPayload, "sub" | "iat" | "jti">): void {
    if (this.isRevoked(payload)) {
      throw new AuthError("REVOKED_TOKEN", "Token has been revoked");
    }
  }

  /** Drop denylist entries whose tokens have already expired. Returns count removed. */
  gc(): number {
    const now = this.now();
    let removed = 0;
    for (const [jti, expMs] of this.revokedJti) {
      if (expMs <= now) {
        this.revokedJti.delete(jti);
        removed += 1;
      }
    }
    return removed;
  }
}
