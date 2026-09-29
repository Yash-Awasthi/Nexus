// SPDX-License-Identifier: Apache-2.0
/**
 * SAML sign-in accepts only an assertion the IdP signed, for a request this
 * server made, and hands the browser its session through the refresh cookie.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { signSamlPost } from "@node-saml/node-saml/lib/saml-post-signing.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const DB = "pglite://:memory:saml-routes";
const IDP = "urn:idp.example.com";
const SP = "urn:nexus:test";
const ACS = "http://localhost:3000/api/v1/auth/saml/callback";
Object.assign(process.env, {
  NEXUS_JWT_SECRET: "saml-routes-secret",
  DATABASE_URL: DB,
  NEXUS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "nexus-saml-")),
  NEXUS_SAML_ENABLED: "true",
  NEXUS_SAML_IDP_SSO_URL: "https://idp.example.com/sso",
  NEXUS_SAML_IDP_ENTITY_ID: IDP,
  NEXUS_SAML_IDP_CERT: publicKey,
  NEXUS_SAML_SP_ENTITY_ID: SP,
  NEXUS_SAML_SP_ACS_URL: ACS,
  NEXUS_SAML_COOKIE_SECRET: randomBytes(32).toString("hex"),
  NEXUS_FRONTEND_URL: "http://localhost:3000",
  NEXUS_SSO_AUTO_PROVISION: "1",
  NEXUS_SSO_ALLOWED_DOMAINS: "example.com",
});

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { authUsersRoutes } = await import("../../src/routes/auth-users.js");
const { samlRoutes } = await import("../../src/routes/saml.js");

const BROWSER = "text/html,application/xhtml+xml,*/*;q=0.8";
let app: FastifyInstance;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(samlRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

/** Start a sign-in and return the AuthnRequest ID the IdP must answer, plus the RelayState. */
async function startSignIn(redirect = "/"): Promise<{ requestId: string; relayState: string }> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/auth/saml/login?redirect=${encodeURIComponent(redirect)}`,
  });
  expect(res.statusCode).toBe(302);
  const location = new URL(String(res.headers.location));
  expect(location.origin + location.pathname).toBe("https://idp.example.com/sso");
  const request = inflateRawSync(
    Buffer.from(location.searchParams.get("SAMLRequest")!, "base64"),
  ).toString();
  return {
    requestId: /ID="([^"]+)"/.exec(request)![1]!,
    relayState: location.searchParams.get("RelayState")!,
  };
}

function signedResponse(inResponseTo: string, email: string): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomBytes(8).toString("hex")}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${ACS}" InResponseTo="${inResponseTo}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${randomBytes(8).toString("hex")}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${later}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  return signSamlPost(xml, "/*[local-name(.)='Response']/*[local-name(.)='Assertion']", {
    privateKey,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
  });
}

const post = (xml: string, relayState: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/saml/callback",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: BROWSER },
    payload: new URLSearchParams({
      SAMLResponse: Buffer.from(xml).toString("base64"),
      RelayState: relayState,
    }).toString(),
  });

it("signs a browser in from a signed assertion and returns it to where it started", async () => {
  const { requestId, relayState } = await startSignIn("/knowledge");
  const res = await post(signedResponse(requestId, "saml-user@example.com"), relayState);

  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("http://localhost:3000/login?signed_in=1&next=%2Fknowledge");
  const refresh = /nexus_refresh=([^;]+)/.exec(String(res.headers["set-cookie"]))?.[1];
  expect(refresh).toBeTruthy();

  const exchanged = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: { cookie: `nexus_refresh=${refresh}` },
    payload: {},
  });
  expect(exchanged.statusCode).toBe(200);
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}` },
  });
  expect(me.json()).toMatchObject({ email: "saml-user@example.com", role: "member" });
});

it("refuses an assertion edited after the IdP signed it", async () => {
  const { requestId, relayState } = await startSignIn();
  const forged = signedResponse(requestId, "someone@example.com").replaceAll(
    "someone@example.com",
    "victim@example.com",
  );
  const res = await post(forged, relayState);

  expect(res.statusCode).toBe(302);
  expect(String(res.headers.location)).toMatch(/\/login\?error=/);
  expect(res.headers["set-cookie"]).toBeUndefined();
});

it("refuses a signed assertion for a request this server never made", async () => {
  const { relayState } = await startSignIn();
  const res = await post(signedResponse("_never-issued", "unsolicited@example.com"), relayState);

  expect(String(res.headers.location)).toMatch(/\/login\?error=/);
  expect(res.headers["set-cookie"]).toBeUndefined();
});

it("refuses the same signed response twice", async () => {
  const { requestId, relayState } = await startSignIn();
  const xml = signedResponse(requestId, "replay@example.com");
  expect((await post(xml, relayState)).headers.location).toMatch(/signed_in=1/);
  expect(String((await post(xml, relayState)).headers.location)).toMatch(/\/login\?error=/);
});
