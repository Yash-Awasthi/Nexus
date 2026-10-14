// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-015: reset, verification and security mail, and the email change that could hijack them. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const DB = "pglite://:memory:account-email";
process.env.NEXUS_JWT_SECRET = "account-email-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-account-email-"));
process.env.RESEND_API_KEY = "re_test";
process.env.NEXUS_MAIL_FROM = "Nexus <no-reply@nexus.test>";
process.env.NEXUS_PUBLIC_URL = "https://nexus.test";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");

let app: FastifyInstance;
const sent: { to: string[]; subject: string; text: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.ready();
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== "https://api.resend.com/emails") return realFetch(url, init);
    sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
    return new Response("{}", { status: 200 });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await closePgPools();
});

beforeEach(() => {
  sent.length = 0;
});

const mailTo = async (to: string) => {
  await vi.waitFor(() => expect(sent.some((m) => m.to.includes(to))).toBe(true));
  return sent.filter((m) => m.to.includes(to));
};

async function register(email: string, password: string) {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { authorization: `Bearer ${reg.json<{ accessToken: string }>().accessToken}` };
}

it("mails a reset link on the configured origin, whatever Host the request named", async () => {
  await register("reset@example.com", "Reset-pass-1!");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    headers: { host: "attacker.example" },
    payload: { email: "reset@example.com" },
  });
  const { resetToken } = res.json<{ resetToken: string }>();
  const [mail] = await mailTo("reset@example.com");
  expect(mail!.text).toContain(`https://nexus.test/reset-password?token=${resetToken}`);
  expect(mail!.text).not.toContain("attacker.example");
});

it("mails a verification link", async () => {
  const auth = await register("verify@example.com", "Verify-pass-1!");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/send-verification",
    headers: auth,
  });
  const { verifyToken } = res.json<{ verifyToken: string }>();
  const mails = await mailTo("verify@example.com");
  expect(mails.some((m) => m.text.includes(`/verify-email?token=${verifyToken}`))).toBe(true);
});

it("changes the sign-in email only with the current password, and tells the old address", async () => {
  const auth = await register("before@example.com", "Before-pass-1!");
  const change = (payload: Record<string, string>) =>
    app.inject({ method: "PATCH", url: "/api/v1/auth/me", headers: auth, payload });

  expect((await change({ email: "after@example.com" })).statusCode).toBe(400);
  expect(
    (await change({ email: "after@example.com", currentPassword: "wrong-pass-1!" })).statusCode,
  ).toBe(401);
  const ok = await change({ email: "after@example.com", currentPassword: "Before-pass-1!" });
  expect(ok.statusCode, ok.body).toBe(200);

  const [mail] = await mailTo("before@example.com");
  expect(mail!.subject).toBe("Your sign-in email was changed");
  // A name change needs no password.
  expect((await change({ name: "Renamed" })).statusCode).toBe(200);
});
