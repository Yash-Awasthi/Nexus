// SPDX-License-Identifier: Apache-2.0
// An unverified address belongs to whoever proves it first: signing in through an
// identity provider strips the account of every credential its registrant set.

import { db } from "@nexus/db";
import { users } from "@nexus/db/schema";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import { emitAuditEvent } from "./audit-emitter.ts";
import { endAllSessions } from "./session-revocation.ts";

/** Make `user` safe to enter through `provider`; a no-op once its email is verified. */
export async function claimForSso(
  user: { id: string; emailVerified: boolean },
  provider: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (user.emailVerified) return;
  const claimed = await db
    .update(users)
    .set({
      passwordHash: `oauth:${provider}:no-password`,
      mfaEnabled: false,
      totpSecret: null,
      mfaRecoveryCodes: [],
      emailVerified: true,
    })
    .where(and(eq(users.id, user.id), eq(users.emailVerified, false)))
    .returning({ id: users.id });
  if (claimed.length === 0) return;
  await endAllSessions(user.id);
  void emitAuditEvent(
    {
      entityType: "user",
      entityId: user.id,
      action: "auth.sso_claimed_unverified",
      actor: user.id,
      payload: { provider },
    },
    logger,
  );
}
