// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-005: a Teams activity is processed only when Bot Framework signed it for this bot and its service URL. */
import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { TeamsBotAdapter, type FetchFn } from "../src/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
const SERVICE = "https://smba.trafficmanager.net/emea/";

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

function token(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "RS256", typ: "JWT", kid: "k1", ...header });
  const p = b64({
    iss: "https://api.botframework.com",
    aud: "app-id",
    serviceurl: SERVICE,
    nbf: now - 10,
    exp: now + 600,
    ...claims,
  });
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

function adapter(): { a: TeamsBotAdapter; fetchFn: ReturnType<typeof vi.fn> } {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.includes("openidconfiguration"))
      return Response.json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
    if (url.endsWith("/keys")) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected ${url}`);
  });
  const a = new TeamsBotAdapter({
    appId: "app-id",
    appPassword: "secret",
    handler: async () => ({ text: "ok" }),
    fetch: fetchFn as unknown as FetchFn,
  });
  return { a, fetchFn };
}

const activity = { type: "message", text: "hi", serviceUrl: SERVICE, conversation: { id: "c" } };

describe("TeamsBotAdapter.authenticate", () => {
  it("accepts a token Bot Framework signed for this bot and service URL", async () => {
    const { a } = adapter();
    await expect(a.authenticate(`Bearer ${token({})}`, activity)).resolves.toBeUndefined();
  });

  it("refuses a request with no token", async () => {
    const { a } = adapter();
    await expect(a.authenticate(undefined, activity)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("refuses a token for another bot", async () => {
    const { a } = adapter();
    await expect(
      a.authenticate(`Bearer ${token({ aud: "someone-else" })}`, activity),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses a token from another issuer", async () => {
    const { a } = adapter();
    await expect(
      a.authenticate(`Bearer ${token({ iss: "https://evil.example" })}`, activity),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses an activity whose service URL the token does not name", async () => {
    const { a } = adapter();
    await expect(
      a.authenticate(`Bearer ${token({})}`, {
        ...activity,
        serviceUrl: "https://attacker.example/",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses an expired token", async () => {
    const { a } = adapter();
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      a.authenticate(`Bearer ${token({ exp: past, nbf: past - 600 })}`, activity),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses a tampered token and a non-RS256 one", async () => {
    const { a } = adapter();
    const good = token({});
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64({ iss: "https://api.botframework.com", aud: "app-id", serviceurl: SERVICE, exp: 9e9 })}.${s}`;
    await expect(a.authenticate(`Bearer ${forged}`, activity)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    await expect(
      a.authenticate(`Bearer ${token({}, { alg: "HS256" })}`, activity),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses everything when the bot has no app id", async () => {
    const a = new TeamsBotAdapter({
      appId: "",
      appPassword: "",
      handler: async () => ({ text: "ok" }),
    });
    await expect(a.authenticate(`Bearer ${token({})}`, activity)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });
});
