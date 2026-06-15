// SPDX-License-Identifier: Apache-2.0
import { createHmac, randomUUID } from "node:crypto";

// ── HMAC abstraction (injectable) ─────────────────────────────────────────────

export type HmacFn = (key: string, data: string) => string;

/** Default hmac. */
export function defaultHmac(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

// ── Payload types ─────────────────────────────────────────────────────────────

export interface GrantPayload {
  /** Unique token identifier. */
  jti: string;
  /** Subject — who this token belongs to (agent id, user id, etc.). */
  sub: string;
  /** Issuer label. */
  iss: string;
  /**
   * Allowed MCP tool IDs. Use `["*"]` to allow all tools.
   * Must be non-empty.
   */
  tools: string[];
  /** Issued-at timestamp (ms since epoch). */
  iat: number;
  /** Expiry timestamp (ms since epoch). */
  exp: number;
  /** Optional extra metadata. */
  metadata?: Record<string, unknown>;
}

/** Grant token interface definition. */
export interface GrantToken {
  raw: string;
  payload: GrantPayload;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export type GrantErrorCode =
  | "EXPIRED"
  | "INVALID_SIGNATURE"
  | "SCOPE_DENIED"
  | "REVOKED"
  | "MALFORMED";

/** Grant error. */
export class GrantError extends Error {
  readonly code: GrantErrorCode;
  constructor(message: string, code: GrantErrorCode) {
    super(message);
    this.name = "GrantError";
    this.code = code;
  }
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encodePayload(payload: GrantPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodePayload(encoded: string): GrantPayload {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GrantPayload;
}

function buildRaw(encoded: string, sig: string): string {
  return `${encoded}.${sig}`;
}

// ── IssueOpts ─────────────────────────────────────────────────────────────────

export interface IssueOpts {
  sub: string;
  /** Allowed tool IDs. Pass `["*"]` to allow all. */
  tools: string[];
  /** Time-to-live in ms. Default: 5 minutes. */
  ttlMs?: number;
  metadata?: Record<string, unknown>;
  /** Override the auto-generated token ID. */
  jti?: string;
}

// ── GrantIssuer ───────────────────────────────────────────────────────────────

export class GrantIssuer {
  constructor(
    private readonly secret: string,
    private readonly hmac: HmacFn = defaultHmac,
    private readonly issuer = "nexus",
  ) {}

  issue(opts: IssueOpts): GrantToken {
    if (!opts.sub.trim()) throw new GrantError("sub must be non-empty", "MALFORMED");
    if (!opts.tools.length) throw new GrantError("tools must be non-empty", "MALFORMED");

    const now = Date.now();
    const payload: GrantPayload = {
      jti: opts.jti ?? randomUUID(),
      sub: opts.sub,
      iss: this.issuer,
      tools: opts.tools,
      iat: now,
      exp: now + (opts.ttlMs ?? 5 * 60 * 1_000),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };

    const encoded = encodePayload(payload);
    const sig = this.hmac(this.secret, encoded);
    return { raw: buildRaw(encoded, sig), payload };
  }
}

// ── VerifyOpts ────────────────────────────────────────────────────────────────

export interface VerifyOpts {
  /** If set, the token must include this tool (or "*"). */
  requiredTool?: string;
  /** Override "now" for testing time-based expiry. */
  nowMs?: number;
}

/** Verify result interface definition. */
export interface VerifyResult {
  valid: boolean;
  payload?: GrantPayload;
  error?: string;
  code?: GrantErrorCode;
}

// ── GrantVerifier ─────────────────────────────────────────────────────────────

export class GrantVerifier {
  constructor(
    private readonly secret: string,
    private readonly hmac: HmacFn = defaultHmac,
  ) {}

  verify(token: string, opts: VerifyOpts = {}): VerifyResult {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) {
      return { valid: false, error: "Malformed token", code: "MALFORMED" };
    }

    const encoded = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    // Verify signature
    const expectedSig = this.hmac(this.secret, encoded);
    if (sig !== expectedSig) {
      return { valid: false, error: "Invalid signature", code: "INVALID_SIGNATURE" };
    }

    // Decode payload
    let payload: GrantPayload;
    try {
      payload = decodePayload(encoded);
    } catch {
      return { valid: false, error: "Malformed payload", code: "MALFORMED" };
    }

    // Check expiry
    const now = opts.nowMs ?? Date.now();
    if (now > payload.exp) {
      return { valid: false, payload, error: "Token expired", code: "EXPIRED" };
    }

    // Check tool scope
    if (opts.requiredTool) {
      const allowed =
        payload.tools.includes("*") || payload.tools.includes(opts.requiredTool);
      if (!allowed) {
        return {
          valid: false,
          payload,
          error: `Tool '${opts.requiredTool}' not in scope [${payload.tools.join(", ")}]`,
          code: "SCOPE_DENIED",
        };
      }
    }

    return { valid: true, payload };
  }
}

// ── GrantStore ────────────────────────────────────────────────────────────────

/**
 * In-memory store that tracks issued tokens and supports revocation.
 * For production, back this with a Redis/KV store.
 */
export class GrantStore {
  private readonly _tokens = new Map<string, GrantToken>();
  private readonly _revoked = new Set<string>();

  constructor(
    private readonly issuer: GrantIssuer,
    private readonly verifier: GrantVerifier,
  ) {}

  /** Issue a token and record it in the store. */
  issue(opts: IssueOpts): GrantToken {
    const token = this.issuer.issue(opts);
    this._tokens.set(token.payload.jti, token);
    return token;
  }

  /** Revoke a token by its jti. */
  revoke(jti: string): boolean {
    if (!this._tokens.has(jti)) return false;
    this._revoked.add(jti);
    return true;
  }

  isRevoked(jti: string): boolean {
    return this._revoked.has(jti);
  }

  /** Verify token and additionally check the store for revocation. */
  verify(raw: string, opts: VerifyOpts = {}): VerifyResult {
    const result = this.verifier.verify(raw, opts);
    if (!result.valid) return result;

    const jti = result.payload!.jti;
    if (this._revoked.has(jti)) {
      return { valid: false, payload: result.payload, error: "Token revoked", code: "REVOKED" };
    }

    return result;
  }

  list(): GrantToken[] {
    return Array.from(this._tokens.values());
  }

  size(): number {
    return this._tokens.size;
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function makeGrantSystem(
  secret: string,
  opts: { hmac?: HmacFn; issuer?: string } = {},
): { issuer: GrantIssuer; verifier: GrantVerifier; store: GrantStore } {
  const hmac = opts.hmac ?? defaultHmac;
  const issuerLabel = opts.issuer ?? "nexus";
  const issuer = new GrantIssuer(secret, hmac, issuerLabel);
  const verifier = new GrantVerifier(secret, hmac);
  const store = new GrantStore(issuer, verifier);
  return { issuer, verifier, store };
}
