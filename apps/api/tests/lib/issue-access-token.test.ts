// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { verifyJwt, verifyJwtRS256 } from "@nexus/auth";
import { issueAccessToken, toNexusRole } from "../../src/lib/issue-access-token.js";

const SECRET = "test-jwt-secret";
const { privateKey: kp, publicKey: pub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// PKCS#1/PKCS#8 PEM strings — same format the auth package tests prove works
// with signJwtRS256 / verifyJwtRS256 on this Node version.
const privateKey = kp.export({ type: "pkcs1", format: "pem" }).toString();
const publicKey = pub.export({ type: "spki", format: "pem" }).toString();

const ENV_KEYS = ["NEXUS_JWT_ALG", "NEXUS_JWT_PRIVATE_KEY", "NEXUS_JWT_SECRET"] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function withEnv(k: (typeof ENV_KEYS)[number], v: string | undefined) {
  if (!saved.has(k)) saved.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe("toNexusRole", () => {
  it("maps platform roles to NexusRoles", () => {
    expect(toNexusRole("owner")).toBe("admin");
    expect(toNexusRole("admin")).toBe("admin");
    expect(toNexusRole("member")).toBe("agent");
    expect(toNexusRole("viewer")).toBe("read-only");
    expect(toNexusRole("unknown")).toBe("read-only");
  });
});

describe("issueAccessToken (HS256, default)", () => {
  it("signs a verifiable HS256 token with the secret", () => {
    const { accessToken, expiresIn } = issueAccessToken("u-1", "member", "free", SECRET);
    expect(expiresIn).toBe(15 * 60);
    const payload = verifyJwt(accessToken, SECRET);
    expect(payload.sub).toBe("u-1");
    expect(payload.role).toBe("agent"); // member → agent via toNexusRole
    expect(payload.tier).toBe("free");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("uses NEXUS_JWT_SECRET when no explicit secret is passed", () => {
    withEnv("NEXUS_JWT_SECRET", SECRET);
    const { accessToken } = issueAccessToken("u-2", "admin");
    expect(verifyJwt(accessToken, SECRET).sub).toBe("u-2");
  });

  it("throws when no secret is configured", () => {
    withEnv("NEXUS_JWT_SECRET", undefined);
    expect(() => issueAccessToken("u-3", "member")).toThrow("NEXUS_JWT_SECRET is not set");
  });
});

describe("issueAccessToken (RS256, §14.1)", () => {
  it("signs an RS256 token verifiable only with the public key", () => {
    withEnv("NEXUS_JWT_ALG", "RS256");
    withEnv("NEXUS_JWT_PRIVATE_KEY", privateKey);
    const { accessToken, expiresIn } = issueAccessToken("u-4", "owner", "free", SECRET);
    expect(expiresIn).toBe(15 * 60);
    const payload = verifyJwtRS256(accessToken, publicKey);
    expect(payload.sub).toBe("u-4");
    expect(payload.role).toBe("admin");
    // The shared secret must NOT verify an RS256 token (alg pinning).
    expect(() => verifyJwt(accessToken, SECRET)).toThrow();
  });

  it("throws when NEXUS_JWT_PRIVATE_KEY is missing in RS256 mode", () => {
    withEnv("NEXUS_JWT_ALG", "RS256");
    withEnv("NEXUS_JWT_PRIVATE_KEY", undefined);
    expect(() => issueAccessToken("u-5", "member", "free", SECRET)).toThrow(
      "NEXUS_JWT_PRIVATE_KEY is not set",
    );
  });
});
