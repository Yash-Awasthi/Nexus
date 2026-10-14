// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-009: passkeys are added by a signed-in owner and sign in without a password. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:passkeys";
const ORIGIN = "https://nexus.test";
process.env.NEXUS_JWT_SECRET = "passkeys-secret";
process.env.NEXUS_API_KEY = "passkeys-master-key";
process.env.DATABASE_URL = DB;
process.env.NEXUS_PUBLIC_URL = ORIGIN;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-passkeys-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");

let app: FastifyInstance;
let nextAddress = 1;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

// ── A software authenticator: P-256 keys, "none" attestation, a minimal CBOR encoder ──

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  const entries = [...(v as Map<unknown, unknown>)];
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]),
  ]);
}

const rpIdHash = crypto.createHash("sha256").update(new URL(ORIGIN).hostname).digest();

function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  let userHandle = "";
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    id: b64u(credId),
    create(options: { challenge: string; user: { id: string } }) {
      userHandle = options.user.id;
      const cose = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, "base64url")],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ]),
      );
      const count = Buffer.alloc(4);
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]),
        count,
        Buffer.alloc(16),
        Buffer.from([0, credId.length]),
        credId,
        cose,
      ]);
      const attestation = cbor(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", options.challenge)),
          attestationObject: b64u(attestation),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    get(options: { challenge: string }) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), count]);
      const data = clientData("webauthn.get", options.challenge);
      const signed = Buffer.concat([authData, crypto.createHash("sha256").update(data).digest()]);
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        response: {
          clientDataJSON: b64u(data),
          authenticatorData: b64u(authData),
          signature: b64u(crypto.sign("sha256", signed, privateKey)),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function account(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: `198.51.100.${nextAddress++}`,
    payload: { email, password: "Passkey-pass-1!" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ accessToken: string }>().accessToken;
}

const call = (method: "GET" | "POST" | "DELETE", url: string, token?: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload ? { payload } : {}),
  });

async function addPasskey(token: string, device = authenticator()) {
  const options = await call("POST", "/api/v1/auth/passkeys/register/options", token);
  expect(options.statusCode, options.body).toBe(200);
  const res = await call("POST", "/api/v1/auth/passkeys/register", token, {
    name: "Laptop",
    response: device.create(options.json()),
  });
  expect(res.statusCode, res.body).toBe(201);
  return device;
}

async function signInWith(device: ReturnType<typeof authenticator>) {
  const options = await call("POST", "/api/v1/auth/passkeys/login/options");
  const { challengeId, options: opts } = options.json<{
    challengeId: string;
    options: { challenge: string };
  }>();
  return {
    challengeId,
    res: await call("POST", "/api/v1/auth/passkeys/login", undefined, {
      challengeId,
      response: device.get(opts),
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

it("adds a passkey and signs in with it, no password asked", async () => {
  const token = await account("passkey@example.com");
  const device = await addPasskey(token);

  const list = await call("GET", "/api/v1/auth/passkeys", token);
  expect(list.json<{ passkeys: { id: string; name: string }[] }>().passkeys).toEqual([
    expect.objectContaining({ id: device.id, name: "Laptop" }),
  ]);

  const { res } = await signInWith(device);
  expect(res.statusCode, res.body).toBe(200);
  const signedIn = res.json<{ accessToken: string; user: { email: string } }>();
  expect(signedIn.user.email).toBe("passkey@example.com");
  expect((await call("GET", "/api/v1/auth/me", signedIn.accessToken)).statusCode).toBe(200);
});

it("spends each sign-in challenge once", async () => {
  const device = await addPasskey(await account("replay@example.com"));
  const { challengeId, res } = await signInWith(device);
  expect(res.statusCode).toBe(200);
  const again = await call("POST", "/api/v1/auth/passkeys/login", undefined, {
    challengeId,
    response: device.get({ challenge: "anything" }),
  });
  expect(again.statusCode).toBe(401);
});

it("refuses an assertion made for another site", async () => {
  const token = await account("phished@example.com");
  const options = await call("POST", "/api/v1/auth/passkeys/register/options", token);
  const device = authenticator();
  await call("POST", "/api/v1/auth/passkeys/register", token, {
    name: "Phone",
    response: device.create(options.json()),
  });
  const opts = (await call("POST", "/api/v1/auth/passkeys/login/options")).json<{
    challengeId: string;
    options: { challenge: string };
  }>();
  const forged = device.get(opts.options);
  const data = JSON.parse(Buffer.from(forged.response.clientDataJSON, "base64url").toString()) as {
    origin: string;
  };
  data.origin = "https://nexus-login.example";
  forged.response.clientDataJSON = b64u(JSON.stringify(data));
  const res = await call("POST", "/api/v1/auth/passkeys/login", undefined, {
    challengeId: opts.challengeId,
    response: forged,
  });
  expect(res.statusCode).toBe(401);
});

it("lets only the owner remove a passkey, and a removed one no longer signs in", async () => {
  const alice = await account("owner-pk@example.com");
  const bob = await account("other-pk@example.com");
  const device = await addPasskey(alice);
  expect((await call("DELETE", `/api/v1/auth/passkeys/${device.id}`, bob)).statusCode).toBe(404);
  expect((await call("DELETE", `/api/v1/auth/passkeys/${device.id}`, alice)).statusCode).toBe(204);
  expect((await signInWith(device)).res.statusCode).toBe(401);
});

it("does not register a passkey without a fresh challenge", async () => {
  const token = await account("nochallenge@example.com");
  const res = await call("POST", "/api/v1/auth/passkeys/register", token, {
    name: "Stale",
    response: authenticator().create({ challenge: b64u("made-up"), user: { id: b64u("x") } }),
  });
  expect(res.statusCode).toBe(400);
});
