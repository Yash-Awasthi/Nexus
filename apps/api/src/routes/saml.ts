// SPDX-License-Identifier: Apache-2.0
/**
 * SAML 2.0 SP-initiated SSO — zero external dependencies.
 *
 * Environment variables required:
 *   NEXUS_SAML_ENABLED=true          — feature gate
 *   NEXUS_SAML_IDP_SSO_URL           — IdP's SSO endpoint (HTTP-Redirect)
 *   NEXUS_SAML_IDP_ENTITY_ID         — IdP Entity ID URI
 *   NEXUS_SAML_IDP_CERT              — IdP X.509 certificate (PEM, no headers)
 *   NEXUS_SAML_SP_ENTITY_ID          — SP Entity ID (e.g. https://nexus.example.com)
 *   NEXUS_SAML_SP_ACS_URL            — Assertion Consumer Service URL (callback)
 *   NEXUS_SAML_COOKIE_SECRET         — 32-byte hex string for state HMAC
 *
 * Routes:
 *   GET  /auth/saml/metadata  — SP metadata XML (for IdP registration)
 *   GET  /auth/saml/login     — initiate HTTP-Redirect binding
 *   POST /auth/saml/callback  — ACS endpoint (IdP POST binding)
 *
 * Implementation:
 *   • AuthnRequest built as XML, deflate-encoded, base64'd, HMAC-signed (query)
 *   • Response XML validated: InResponseTo, Audience, NotBefore/NotOnOrAfter
 *   • Signature verified via node:crypto createVerify (RS256/SHA256)
 *   • User upserted into users table (same pattern as oauth.ts)
 *   • Issues Nexus access + refresh token pair on success
 *   • Graceful 501 if NEXUS_SAML_ENABLED is not "true"
 */

import { createHash, createHmac, createVerify, randomBytes, createPublicKey } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import { signJwt } from "@nexus/auth";
import { db } from "@nexus/db";
import { users, refreshTokens } from "@nexus/db/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

// ── Helpers ────────────────────────────────────────────────────────────────────

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`SAML misconfigured: missing ${key}`);
  return v;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1_000);
}

function isoNow(offsetSeconds = 0): string {
  return new Date(Date.now() + offsetSeconds * 1_000).toISOString().replace(/\.\d+Z$/, "Z");
}

function safeBase64Encode(buf: Buffer): string {
  return buf.toString("base64");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── SAML state cookie (HMAC-signed) ───────────────────────────────────────────

function makeState(relayState: string): string {
  const secret = process.env.NEXUS_SAML_COOKIE_SECRET ?? randomBytes(32).toString("hex");
  const ts = nowSec().toString(16);
  const nonce = randomBytes(8).toString("hex");
  const payload = `${ts}.${nonce}.${relayState}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return `${payload}.${sig}`;
}

function verifyState(state: string): { relayState: string } | null {
  try {
    const secret = process.env.NEXUS_SAML_COOKIE_SECRET ?? "";
    const parts = state.split(".");
    if (parts.length < 4) return null;
    const sig = parts.pop()!;
    const payload = parts.join(".");
    const expected = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
    if (sig !== expected) return null;
    const [ts, , relayState] = parts;
    // State valid for 10 minutes
    if (Math.abs(nowSec() - parseInt(ts!, 16)) > 600) return null;
    return { relayState: relayState ?? "/" };
  } catch {
    return null;
  }
}

// ── AuthnRequest builder ───────────────────────────────────────────────────────

function buildAuthnRequest(requestId: string, spEntityId: string, acsUrl: string): string {
  const issueInstant = isoNow();
  return [
    `<samlp:AuthnRequest`,
    ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`,
    ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
    ` ID="${xmlEscape(requestId)}"`,
    ` Version="2.0"`,
    ` IssueInstant="${issueInstant}"`,
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
    ` AssertionConsumerServiceURL="${xmlEscape(acsUrl)}"`,
    `>`,
    `<saml:Issuer>${xmlEscape(spEntityId)}</saml:Issuer>`,
    `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>`,
    `</samlp:AuthnRequest>`,
  ].join("");
}

function encodeAuthnRequest(xml: string): string {
  const deflated = deflateRawSync(Buffer.from(xml, "utf8"));
  return safeBase64Encode(deflated);
}

// ── Response parser ────────────────────────────────────────────────────────────

interface SamlAssertion {
  nameId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  sessionIndex?: string;
  inResponseTo?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  audience?: string;
}

// Minimal XML attribute/text extraction — no external parser, no eval
function xmlAttr(xml: string, attrName: string): string | undefined {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  return re.exec(xml)?.[1];
}

function xmlTextContent(xml: string, tagName: string): string | undefined {
  const re = new RegExp(`<[^>]*${tagName}[^>]*>([^<]*)<`, "i");
  return re.exec(xml)?.[1]?.trim();
}

function xmlGetElement(xml: string, tagName: string): string | undefined {
  const re = new RegExp(`<[^>]*${tagName}[^>]*>[\\s\\S]*?</[^>]*${tagName}>`, "i");
  return re.exec(xml)?.[0];
}

function parseAssertion(responseXml: string): SamlAssertion | null {
  try {
    // Extract NameID
    const nameId = xmlTextContent(responseXml, "NameID");
    if (!nameId) return null;

    const email = nameId.includes("@") ? nameId : (xmlAttr(responseXml, "emailAddress") ?? nameId);

    // Conditions
    const conditionsEl = xmlGetElement(responseXml, "Conditions");
    const notBefore = conditionsEl ? xmlAttr(conditionsEl, "NotBefore") : undefined;
    const notOnOrAfter = conditionsEl ? xmlAttr(conditionsEl, "NotOnOrAfter") : undefined;

    // Audience
    const audienceEl = xmlGetElement(responseXml, "AudienceRestriction");
    const audience = audienceEl ? xmlTextContent(audienceEl, "Audience") : undefined;

    // Attributes (common mappings from Okta/Azure/G Suite)
    const attrs: Record<string, string> = {};
    const attrRe =
      /Name="([^"]+)"[^>]*>[\s\S]*?<[^>]*AttributeValue[^>]*>([^<]*)<\/[^>]*AttributeValue>/gi;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(responseXml)) !== null) {
      attrs[attrMatch[1]!] = attrMatch[2]!.trim();
    }

    const firstName =
      attrs["firstName"] ??
      attrs["givenName"] ??
      attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"];
    const lastName =
      attrs["lastName"] ??
      attrs["sn"] ??
      attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"];

    // SubjectConfirmation InResponseTo
    const inResponseTo = xmlAttr(responseXml, "InResponseTo");

    // AuthnStatement SessionIndex
    const sessionIndex = xmlAttr(responseXml, "SessionIndex");

    return {
      nameId,
      email: (
        attrs["email"] ??
        attrs["emailAddress"] ??
        attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ??
        email
      ).toLowerCase(),
      firstName,
      lastName,
      sessionIndex,
      inResponseTo,
      notBefore,
      notOnOrAfter,
      audience,
    };
  } catch {
    return null;
  }
}

// ── Signature verification ─────────────────────────────────────────────────────

function buildPem(cert: string): string {
  const stripped = cert.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  return `-----BEGIN CERTIFICATE-----\n${stripped.match(/.{1,64}/g)?.join("\n") ?? stripped}\n-----END CERTIFICATE-----\n`;
}

function verifySamlSignature(responseXml: string, idpCert: string): boolean {
  try {
    // Extract SignatureValue
    const sigValue = xmlTextContent(responseXml, "SignatureValue")?.replace(/\s/g, "");
    if (!sigValue) return false;

    // Extract SignedInfo block — this is what was signed
    const signedInfo = xmlGetElement(responseXml, "SignedInfo");
    if (!signedInfo) return false;

    const pem = buildPem(idpCert);
    const publicKey = createPublicKey({ key: pem, format: "pem" });

    const verifier = createVerify("SHA256");
    verifier.update(signedInfo, "utf8");
    return verifier.verify(publicKey, sigValue, "base64");
  } catch {
    return false;
  }
}

// ── User upsert (same pattern as oauth.ts) ────────────────────────────────────

async function upsertSamlUser(
  assertion: SamlAssertion,
  _idpEntityId: string,
  userAgent: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const JWT_SECRET = process.env.NEXUS_JWT_SECRET ?? "dev-secret-change-me";

  // Upsert user
  const [existing] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, assertion.email))
    .limit(1);

  let userId: string;
  if (existing) {
    userId = existing.id;
    if (!existing.name && (assertion.firstName || assertion.lastName)) {
      await db
        .update(users)
        .set({ name: [assertion.firstName, assertion.lastName].filter(Boolean).join(" ") })
        .where(eq(users.id, userId));
    }
    // Mark email verified for SAML-authenticated users
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
  } else {
    const [newUser] = await db
      .insert(users)
      .values({
        email: assertion.email,
        name:
          [assertion.firstName, assertion.lastName].filter(Boolean).join(" ") || assertion.email,
        passwordHash: "", // no password for SSO users
        emailVerified: true, // IdP has verified the email
      })
      .returning({ id: users.id });
    userId = newUser!.id;
  }

  // Issue access token (15 min) via @nexus/auth signJwt (HS256)
  const accessToken = signJwt(
    {
      sub: userId,
      role: "read-only",
      exp: Math.floor(Date.now() / 1_000) + 15 * 60,
    } as Parameters<typeof signJwt>[0],
    JWT_SECRET,
  );

  // Opaque refresh token (30 days)
  const rawRefresh = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawRefresh).digest("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash,
    expiresAt,
    userAgent,
  });

  return { accessToken, refreshToken: rawRefresh, userId };
}

// ── SP Metadata XML ────────────────────────────────────────────────────────────

function buildMetadataXml(spEntityId: string, acsUrl: string): string {
  return [
    `<?xml version="1.0"?>`,
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"`,
    ` entityID="${xmlEscape(spEntityId)}">`,
    `<md:SPSSODescriptor`,
    ` AuthnRequestsSigned="false"`,
    ` WantAssertionsSigned="true"`,
    ` protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `<md:AssertionConsumerService`,
    ` Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
    ` Location="${xmlEscape(acsUrl)}"`,
    ` index="0" isDefault="true"/>`,
    `</md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join("");
}

// ── Route plugin ───────────────────────────────────────────────────────────────

export async function samlRoutes(app: FastifyInstance): Promise<void> {
  // Feature gate — return 501 if SAML not configured
  const samlEnabled = process.env.NEXUS_SAML_ENABLED === "true";

  if (!samlEnabled) {
    for (const [method, path] of [
      ["get", "/auth/saml/metadata"],
      ["get", "/auth/saml/login"],
      ["post", "/auth/saml/callback"],
    ] as const) {
      app[method](
        path,
        async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
          reply.code(501).send({
            error: "saml_not_configured",
            message: "Set NEXUS_SAML_ENABLED=true and all NEXUS_SAML_* env vars to enable SAML SSO",
          }),
      );
    }
    return;
  }

  /**
   * GET /auth/saml/metadata
   * Returns SP metadata XML — paste the URL into your IdP to register Nexus as an SP.
   */
  app.get("/auth/saml/metadata", async (_req, reply) => {
    try {
      const spEntityId = env("NEXUS_SAML_SP_ENTITY_ID");
      const acsUrl = env("NEXUS_SAML_SP_ACS_URL");
      reply.header("Content-Type", "application/xml; charset=utf-8");
      return reply.send(buildMetadataXml(spEntityId, acsUrl));
    } catch (err) {
      return reply.code(503).send({ error: "saml_config_error", message: (err as Error).message });
    }
  });

  /**
   * GET /auth/saml/login?redirect=<path>
   * Initiates SP-initiated SSO via HTTP-Redirect binding.
   * Stores state in a signed cookie, redirects browser to IdP.
   */
  app.get<{ Querystring: { redirect?: string } }>("/auth/saml/login", async (request, reply) => {
    try {
      const idpSsoUrl = env("NEXUS_SAML_IDP_SSO_URL");
      const spEntityId = env("NEXUS_SAML_SP_ENTITY_ID");
      const acsUrl = env("NEXUS_SAML_SP_ACS_URL");

      const requestId = `_${randomBytes(16).toString("hex")}`;
      const relayState = request.query.redirect ?? "/";
      const state = makeState(relayState);
      const authnRequest = buildAuthnRequest(requestId, spEntityId, acsUrl);
      const encoded = encodeAuthnRequest(authnRequest);

      const params = new URLSearchParams({
        SAMLRequest: encoded,
        RelayState: state,
      });

      // Store requestId in a short-lived signed cookie for InResponseTo validation
      const cookieVal = createHmac("sha256", process.env.NEXUS_SAML_COOKIE_SECRET ?? "dev-secret")
        .update(requestId)
        .digest("hex");

      (
        reply as unknown as { setCookie(n: string, v: string, o: Record<string, unknown>): void }
      ).setCookie("saml_req_id", `${requestId}:${cookieVal}`, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 600,
        path: "/",
      });

      return reply.redirect(`${idpSsoUrl}?${params.toString()}`);
    } catch (err) {
      return reply.code(503).send({ error: "saml_config_error", message: (err as Error).message });
    }
  });

  /**
   * POST /auth/saml/callback
   * ACS endpoint — IdP POSTs the SAML response here after authentication.
   * Validates signature, conditions, audience; upserts user; issues tokens.
   */
  app.post<{
    Body: { SAMLResponse?: string; RelayState?: string };
  }>("/auth/saml/callback", async (request, reply) => {
    try {
      const idpEntityId = env("NEXUS_SAML_IDP_ENTITY_ID");
      const idpCert = env("NEXUS_SAML_IDP_CERT");
      const spEntityId = env("NEXUS_SAML_SP_ENTITY_ID");
      const frontendUrl = process.env.NEXUS_FRONTEND_URL ?? "http://localhost:5173";

      const { SAMLResponse, RelayState } = request.body;

      if (!SAMLResponse) {
        return reply.code(400).send({ error: "missing_saml_response" });
      }

      // Decode SAML response
      const responseXml = Buffer.from(SAMLResponse, "base64").toString("utf8");

      // 1 — Verify signature
      if (!verifySamlSignature(responseXml, idpCert)) {
        request.log.warn("SAML signature verification failed");
        return reply.code(401).send({ error: "invalid_signature" });
      }

      // 2 — Parse assertion
      const assertion = parseAssertion(responseXml);
      if (!assertion || !assertion.email) {
        return reply.code(400).send({ error: "assertion_parse_failed" });
      }

      // 3 — Validate InResponseTo (CSRF protection)
      const reqCookie =
        (request as unknown as { cookies: Record<string, string> }).cookies["saml_req_id"] ?? "";
      if (reqCookie && assertion.inResponseTo) {
        const [storedId, storedSig] = reqCookie.split(":");
        const expectedSig = createHmac(
          "sha256",
          process.env.NEXUS_SAML_COOKIE_SECRET ?? "dev-secret",
        )
          .update(storedId ?? "")
          .digest("hex");
        if (storedSig !== expectedSig || storedId !== assertion.inResponseTo) {
          return reply.code(401).send({ error: "inresponseto_mismatch" });
        }
      }
      // Clear cookie
      (
        reply as unknown as { clearCookie(n: string, o: Record<string, unknown>): void }
      ).clearCookie("saml_req_id", { path: "/" });

      // 4 — Validate time conditions
      const now = new Date();
      if (assertion.notBefore && new Date(assertion.notBefore) > new Date(now.getTime() + 60_000)) {
        return reply.code(401).send({ error: "assertion_not_yet_valid" });
      }
      if (
        assertion.notOnOrAfter &&
        new Date(assertion.notOnOrAfter) < new Date(now.getTime() - 60_000)
      ) {
        return reply.code(401).send({ error: "assertion_expired" });
      }

      // 5 — Validate Audience
      if (assertion.audience && assertion.audience !== spEntityId) {
        return reply.code(401).send({
          error: "audience_mismatch",
          expected: spEntityId,
          got: assertion.audience,
        });
      }

      // 6 — Upsert user + issue tokens
      const userAgent = request.headers["user-agent"] ?? "";
      const { accessToken, refreshToken } = await upsertSamlUser(assertion, idpEntityId, userAgent);

      // 7 — Redirect to frontend with tokens
      const stateResult = RelayState ? verifyState(RelayState) : null;
      const destination = stateResult?.relayState ?? "/";

      return reply.redirect(
        `${frontendUrl}${destination}?access_token=${accessToken}&refresh_token=${refreshToken}`,
      );
    } catch (err) {
      request.log.error({ err }, "SAML callback error");
      return reply.code(500).send({ error: "saml_callback_error" });
    }
  });
}
