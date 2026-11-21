// SPDX-License-Identifier: Apache-2.0
/**
 * The OIDC round trip, end to end against a local stub identity provider:
 * discovery → authorize redirect → code exchange → JWKS signature check →
 * user provisioning → Nexus token pair. The stub signs a real RS256 ID token,
 * so the JWKS path and claim validation run exactly as they would live.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";

const pinnedFetchMock = vi.fn((...args: Parameters<typeof fetch>) => fetch(...args));
vi.mock("@nexus/agent-core/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/agent-core/kernel")>()),
  pinnedFetch: (...args: Parameters<typeof fetch>) => pinnedFetchMock(...args),
}));

const SECRET = "oidc-round-trip-secret";
const DB = "pglite://:memory:oidc-round-trip";
const CLIENT_ID = "nexus-test-client";
const CLIENT_SECRET = "nexus-test-secret";
const EMAIL = "oidc-tester@example.com";
const REDIRECT_URI = "http://localhost:3000/api/v1/auth/oidc/callback";
const KID = "round-trip-key";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

let issuer = "";
const seen: { code?: string; redirectUri?: string; clientSecret?: string } = {};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT", kid: KID });
  const claims = b64({
    iss: issuer,
    sub: "oidc-subject-1",
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    email: EMAIL,
    email_verified: true,
    name: "OIDC Tester",
  });
  const signature = crypto
    .sign("sha256", Buffer.from(`${head}.${claims}`), privateKey)
    .toString("base64url");
  return `${head}.${claims}.${signature}`;
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const idp = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
  if (url.pathname === "/.well-known/openid-configuration") {
    return sendJson(res, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === "/jwks") {
    return sendJson(res, {
      keys: [{ ...publicJwk, kid: KID, use: "sig", alg: "RS256" }],
    });
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      seen.code = body.get("code") ?? undefined;
      seen.redirectUri = body.get("redirect_uri") ?? undefined;
      seen.clientSecret = body.get("client_secret") ?? undefined;
      if (body.get("client_secret") !== CLIENT_SECRET) {
        return sendJson(res, { error: "invalid_client" }, 401);
      }
      return sendJson(res, { id_token: idToken(), access_token: "stub", token_type: "Bearer" });
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

let app: FastifyInstance;

beforeAll(async () => {
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  process.env.NEXUS_OIDC_ISSUER = issuer;
  process.env.NEXUS_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.NEXUS_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.NEXUS_OIDC_REDIRECT_URI = REDIRECT_URI;
  process.env.NEXUS_JWT_SECRET = SECRET;
  process.env.NEXUS_SSO_AUTO_PROVISION = "1";
  process.env.NEXUS_SSO_ALLOWED_DOMAINS = "example.com";
  process.env.DATABASE_URL = DB;

  const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
  const { getPgPool } = await import("../../src/lib/pg-pool.ts");
  const { buildServer } = await import("../../src/server.ts");
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  const { closePgPools } = await import("../../src/lib/pg-pool.ts");
  await closePgPools();
});

async function authorize(): Promise<{ location: URL; cookie: string }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/authorize" });
  expect(res.statusCode).toBe(302);
  const location = new URL(String(res.headers.location));
  expect(`${location.origin}${location.pathname}`).toBe(`${issuer}/authorize`);
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(location.searchParams.get("scope")).toContain("openid");
  const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  return { location, cookie };
}

it("signs in through discovery, token exchange, JWKS and user provisioning", async () => {
  const { location, cookie } = await authorize();
  const state = location.searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=good-code&state=${encodeURIComponent(state!)}`,
    headers: { accept: "application/json", cookie },
  });

  expect(callback.statusCode).toBe(200);
  const body = callback.json<{
    accessToken: string;
    refreshToken: string;
    userId: string;
    provider: string;
  }>();
  expect(body.accessToken).toBeTypeOf("string");
  expect(body.refreshToken).toBeTypeOf("string");
  expect(body.userId).toBeTruthy();
  expect(body.provider).toBe("oidc");

  expect(seen.code).toBe("good-code");
  expect(seen.redirectUri).toBe(REDIRECT_URI);
  expect(seen.clientSecret).toBe(CLIENT_SECRET);

  const { db } = await import("@nexus/db");
  const { users } = await import("@nexus/db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  expect(user?.id).toBe(body.userId);
  expect(user?.emailVerified).toBe(true);
  expect(user?.name).toBe("OIDC Tester");
});

it("hands a browser the refresh cookie instead of the token body", async () => {
  const { location, cookie } = await authorize();
  const state = location.searchParams.get("state");

  const callback = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=browser-code&state=${encodeURIComponent(state!)}`,
    headers: { accept: "text/html", cookie },
  });

  expect(callback.statusCode).toBe(302);
  expect(String(callback.headers.location)).toContain("/login?signed_in=1");
  const setCookie = String(callback.headers["set-cookie"] ?? "");
  expect(setCookie).toContain("nexus_refresh=");
  expect(setCookie).toContain("HttpOnly");
  expect(callback.body).toBe("");
});
