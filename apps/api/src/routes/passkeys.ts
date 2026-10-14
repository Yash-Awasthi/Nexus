// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys (NX-FEAT-009): WebAuthn credentials an owner adds while signed in and later signs in
 * with, no password asked. User verification (PIN or biometric) is required, so a passkey is two
 * factors on its own and skips the authenticator-code step.
 *
 * The relying party is the configured public origin (NEXUS_PUBLIC_URL, else OAUTH_REDIRECT_BASE),
 * never the request's Host; without one, passkeys are off. Challenges are single-use and live in
 * the security KV for five minutes, so any replica can finish a ceremony another started.
 */
import crypto from "node:crypto";

import { db } from "@nexus/db";
import { passkeys, users } from "@nexus/db/schema";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.ts";
import { publicOrigin } from "../lib/mailer.ts";
import { makeRateLimitPreHandler } from "../lib/rate-limiter.ts";
import { securityEvent } from "../lib/security-events.ts";
import { getSecurityKV } from "../lib/shared-kv.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;

type CompleteSignIn = (
  user: typeof users.$inferSelect,
  request: FastifyRequest,
  reply: FastifyReply,
  method: "passkey",
) => Promise<FastifyReply>;

function relyingParty(): { origin: string; rpID: string } | null {
  const origin = publicOrigin(process.env);
  return origin ? { origin, rpID: new URL(origin).hostname } : null;
}

/** Read a challenge and spend it, so a captured response cannot be replayed. */
async function takeChallenge(key: string): Promise<string | undefined> {
  const kv = getSecurityKV();
  const challenge = await kv.get<string>(key);
  if (challenge) await kv.delete(key);
  return challenge;
}

const signInRateLimit = makeRateLimitPreHandler({
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "auth:passkey",
});

const manageRateLimit = makeRateLimitPreHandler({
  limit: 20,
  windowMs: 60_000,
  keyPrefix: "auth:passkey-manage",
});

export async function passkeyRoutes(
  app: FastifyInstance,
  completeSignIn: CompleteSignIn,
): Promise<void> {
  const unavailable = (reply: FastifyReply) =>
    reply.code(503).send({
      error: "passkeys_unavailable",
      message: "Passkeys need NEXUS_PUBLIC_URL, the address users open Nexus at.",
    });

  /** GET /auth/passkeys — the caller's passkeys, and whether this server offers them. */
  app.get("/auth/passkeys", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(403).send({ error: "jwt_required" });
    const rows = await db
      .select({
        id: passkeys.id,
        name: passkeys.name,
        createdAt: passkeys.createdAt,
        lastUsedAt: passkeys.lastUsedAt,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, userId));
    return reply.send({ available: relyingParty() !== null, passkeys: rows });
  });

  /** POST /auth/passkeys/register/options — start adding a passkey. */
  app.post(
    "/auth/passkeys/register/options",
    { preHandler: [requireAuthWithTier, manageRateLimit] },
    async (request, reply) => {
      const rp = relyingParty();
      if (!rp) return unavailable(reply);
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });
      const [user] = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);
      if (!user) return reply.code(404).send({ error: "user_not_found" });
      const existing = await db
        .select({ id: passkeys.id, transports: passkeys.transports })
        .from(passkeys)
        .where(eq(passkeys.userId, userId));
      const options = await generateRegistrationOptions({
        rpName: "Nexus",
        rpID: rp.rpID,
        userName: user.email,
        userDisplayName: user.name ?? user.email,
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        excludeCredentials: existing,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      await getSecurityKV().set(`webauthn:reg:${userId}`, options.challenge, CHALLENGE_TTL_MS);
      return reply.send(options);
    },
  );

  /** POST /auth/passkeys/register — finish adding a passkey. */
  app.post<{ Body: { name?: string; response: RegistrationResponseJSON } }>(
    "/auth/passkeys/register",
    {
      preHandler: [requireAuthWithTier, manageRateLimit],
      schema: {
        body: {
          type: "object",
          required: ["response"],
          properties: {
            name: { type: "string", maxLength: 64 },
            response: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const rp = relyingParty();
      if (!rp) return unavailable(reply);
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });
      const challenge = await takeChallenge(`webauthn:reg:${userId}`);
      if (!challenge) return reply.code(400).send({ error: "challenge_expired" });
      const result = await verifyRegistrationResponse({
        response: request.body.response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      }).catch(() => null);
      if (!result?.verified) return reply.code(400).send({ error: "passkey_not_verified" });
      const { credential } = result.registrationInfo;
      const name = request.body.name?.trim() || "Passkey";
      await db.insert(passkeys).values({
        id: credential.id,
        userId,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name,
      });
      await securityEvent(userId, "passkey.added", { message: `Named "${name}".` }, app.log);
      return reply.code(201).send({ id: credential.id, name });
    },
  );

  /** DELETE /auth/passkeys/:id — remove one of the caller's passkeys. */
  app.delete<{ Params: { id: string } }>(
    "/auth/passkeys/:id",
    { preHandler: [requireAuthWithTier, manageRateLimit] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(403).send({ error: "jwt_required" });
      const removed = await db
        .delete(passkeys)
        .where(and(eq(passkeys.id, request.params.id), eq(passkeys.userId, userId)))
        .returning({ name: passkeys.name });
      if (removed.length === 0) return reply.code(404).send({ error: "passkey_not_found" });
      await securityEvent(
        userId,
        "passkey.removed",
        { message: `Named "${removed[0]!.name}".` },
        app.log,
      );
      return reply.code(204).send();
    },
  );

  /** POST /auth/passkeys/login/options — start a passwordless sign-in. */
  app.post(
    "/auth/passkeys/login/options",
    { preHandler: signInRateLimit },
    async (_request, reply) => {
      const rp = relyingParty();
      if (!rp) return unavailable(reply);
      const options = await generateAuthenticationOptions({
        rpID: rp.rpID,
        userVerification: "required",
      });
      const challengeId = crypto.randomUUID();
      await getSecurityKV().set(
        `webauthn:auth:${challengeId}`,
        options.challenge,
        CHALLENGE_TTL_MS,
      );
      return reply.send({ challengeId, options });
    },
  );

  /** POST /auth/passkeys/login — finish a passwordless sign-in. */
  app.post<{ Body: { challengeId: string; response: AuthenticationResponseJSON } }>(
    "/auth/passkeys/login",
    {
      preHandler: signInRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "response"],
          properties: {
            challengeId: { type: "string", maxLength: 64 },
            response: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          },
        },
      },
    },
    async (request, reply) => {
      const rp = relyingParty();
      if (!rp) return unavailable(reply);
      const refused = () =>
        reply
          .code(401)
          .send({ error: "passkey_not_accepted", message: "That passkey was not accepted" });
      const challenge = await takeChallenge(`webauthn:auth:${request.body.challengeId}`);
      if (!challenge) return refused();
      const [key] = await db
        .select()
        .from(passkeys)
        .where(eq(passkeys.id, request.body.response.id))
        .limit(1);
      if (!key) return refused();
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, key.userId), isNull(users.deletedAt)))
        .limit(1);
      if (!user) return refused();
      const result = await verifyAuthenticationResponse({
        response: request.body.response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: key.id,
          publicKey: Buffer.from(key.publicKey, "base64url"),
          counter: key.counter,
          transports: key.transports,
        },
      }).catch(() => null);
      if (!result?.verified) {
        emitAuditEvent(
          {
            entityType: "user",
            entityId: user.id,
            action: "auth.passkey_refused",
            actor: user.id,
            payload: { ip: request.ip },
          },
          app.log,
        );
        return refused();
      }
      await db
        .update(passkeys)
        .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() })
        .where(eq(passkeys.id, key.id));
      return completeSignIn(user, request, reply, "passkey");
    },
  );
}
