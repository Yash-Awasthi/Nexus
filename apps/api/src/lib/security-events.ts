// SPDX-License-Identifier: Apache-2.0
// A change to how someone gets into an account is told to its owner (bell, activity feed and
// email) and written to the hash-chained audit log, so a change they did not make is noticed.

import { db } from "@nexus/db";
import { users } from "@nexus/db/schema";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import { emitAuditEvent } from "./audit-emitter.ts";
import { appLink, mailConfigured, sendMail } from "./mailer.ts";
import { createNotification } from "./notifications-store.ts";

const EVENTS = {
  "signin.new": "New sign-in to your account",
  "password.changed": "Your password was changed",
  "email.changed": "Your sign-in email was changed",
  "mfa.enabled": "Two-factor authentication turned on",
  "mfa.disabled": "Two-factor authentication turned off",
  "mfa.recovery_used": "A recovery code was used to sign in",
  "mfa.recovery_regenerated": "New recovery codes were created",
  "token.created": "A personal access token was created",
  "sessions.revoked": "You were signed out everywhere",
  "signin.locked": "Sign-ins paused after repeated failed passwords",
  "role.changed": "Your account role was changed",
} as const;

export type SecurityEventKind = keyof typeof EVENTS;

/**
 * Tell `userId` about `kind` and record it; `actor` is who did it when that is someone else.
 * `mailTo` overrides the address the email goes to (an email change tells the old address).
 */
export async function securityEvent(
  userId: string,
  kind: SecurityEventKind,
  detail: {
    message?: string;
    actor?: string;
    payload?: Record<string, unknown>;
    mailTo?: string;
  } = {},
  logger?: FastifyBaseLogger,
): Promise<void> {
  void emitAuditEvent(
    {
      entityType: "user",
      entityId: userId,
      action: `security.${kind}`,
      actor: detail.actor ?? userId,
      ...(detail.payload ? { payload: detail.payload } : {}),
    },
    logger,
  );
  const message = `${detail.message ? `${detail.message} ` : ""}If this was not you, change your password and sign out everywhere.`;
  await createNotification(userId, {
    type: "security",
    title: EVENTS[kind],
    message,
    link: "/settings",
  });
  if (mailConfigured()) void mailOwner(userId, EVENTS[kind], message, detail.mailTo, logger);
}

async function mailOwner(
  userId: string,
  subject: string,
  message: string,
  mailTo: string | undefined,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    const to =
      mailTo ??
      (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0]
        ?.email;
    // Accounts without a real inbox (Slack identities) are skipped.
    if (!to || to.endsWith(".invalid")) return;
    await sendMail({ to, subject, text: `${message}\n\n${appLink("/settings")}` }, logger);
  } catch (err) {
    logger?.warn({ err: (err as Error).message }, "security-mail-failed");
  }
}
