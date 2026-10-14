// SPDX-License-Identifier: Apache-2.0
// A change to how someone gets into an account is told to its owner (bell + activity feed) and
// written to the hash-chained audit log, so a change they did not make is noticed (NX-FEAT-003/005).

import type { FastifyBaseLogger } from "fastify";

import { emitAuditEvent } from "./audit-emitter.ts";
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

/** Tell `userId` about `kind` and record it; `actor` is who did it when that is someone else. */
export async function securityEvent(
  userId: string,
  kind: SecurityEventKind,
  detail: { message?: string; actor?: string; payload?: Record<string, unknown> } = {},
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
  await createNotification(userId, {
    type: "security",
    title: EVENTS[kind],
    message: `${detail.message ? `${detail.message} ` : ""}If this was not you, change your password and sign out everywhere.`,
    link: "/settings",
  });
}
