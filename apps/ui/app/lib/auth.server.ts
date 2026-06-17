/**
 * Server-only auth utilities.
 * Uses Web Crypto API (available in Cloudflare Workers + Node.js 18+).
 *
 * JWT structure: base64url(header).base64url(payload).base64url(hmac-sig)
 */

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: "admin" | "member" | "viewer";
}

const COOKIE_NAME = "access_token";
const TOKEN_TTL_SECS = 60 * 60 * 24 * 7; // 7 days

function b64uEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function b64uDecode(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signToken(payload: AuthUser, secret: string): Promise<string> {
  const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECS };
  const body = b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const data = `${header}.${body}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64uEncode(sig)}`;
}

export async function verifyToken(token: string, secret: string): Promise<AuthUser | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, b64uDecode(sig), new TextEncoder().encode(data));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: claims.id, username: claims.username, email: claims.email, role: claims.role };
  } catch {
    return null;
  }
}

export function getSecret(env: { JWT_SECRET?: string }): string {
  return env.JWT_SECRET || "dev-secret-change-in-production-please";
}

export function buildCookie(token: string, clear = false): string {
  if (clear) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL_SECS}`;
}

export function getTokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match?.[1] ?? null;
}

/**
 * Creates a self-validating OAuth state token: `uuid.hmacSig`
 * No cookie needed — the signature proves we issued it.
 */
export async function createOAuthState(secret: string): Promise<string> {
  const id = crypto.randomUUID();
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  return `${id}.${b64uEncode(sig)}`;
}

/**
 * Verifies a state token returned from OAuth provider.
 * Returns true if the signature is valid.
 */
export async function verifyOAuthState(state: string, secret: string): Promise<boolean> {
  try {
    const dot = state.lastIndexOf(".");
    if (dot === -1) return false;
    const id = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const key = await getKey(secret);
    return crypto.subtle.verify("HMAC", key, b64uDecode(sig), new TextEncoder().encode(id));
  } catch {
    return false;
  }
}
