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

import { createHmac, timingSafeEqual } from "node:crypto";

// ── Error ─────────────────────────────────────────────────────────────────────

export type AuthErrorCode =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "EXPIRED_TOKEN"
  | "INSUFFICIENT_ROLE";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly httpStatus: number;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.httpStatus = code === "INSUFFICIENT_ROLE" ? 403 : 401;
  }
}

// ── Token types ───────────────────────────────────────────────────────────────

export type NexusRole = "admin" | "agent" | "read-only";

export interface NexusTokenPayload {
  sub: string;
  role: NexusRole;
  iat: number;
  exp: number;
  /** Optional — agent-specific capability set */
  capabilities?: string[];
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
