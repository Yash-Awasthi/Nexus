// SPDX-License-Identifier: Apache-2.0
/**
 * Transactional email through Brevo's or Resend's HTTP API (NX-FEAT-015).
 *
 *   BREVO_API_KEY    — enables sending through Brevo, which needs only a verified sender address
 *   RESEND_API_KEY   — enables sending through Resend, which needs a verified domain
 *   NEXUS_MAIL_FROM  — sender, e.g. "Nexus <no-reply@example.com>"
 *   NEXUS_PUBLIC_URL — origin the links in a message point at (falls back to OAUTH_REDIRECT_BASE)
 */

import type { FastifyBaseLogger } from "fastify";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export function mailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (
    !!(env.BREVO_API_KEY || env.RESEND_API_KEY) && !!env.NEXUS_MAIL_FROM && !!publicOrigin(env)
  );
}

// Links come from configuration only: a Host header would let a caller point a reset link at itself.
export function publicOrigin(env: Record<string, string | undefined>): string | null {
  const raw = env.NEXUS_PUBLIC_URL ?? env.OAUTH_REDIRECT_BASE;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** An absolute link into the web app, or null when no public origin is configured. */
export function appLink(path: string, env: Record<string, string | undefined> = process.env) {
  const origin = publicOrigin(env);
  return origin ? `${origin}${path}` : null;
}

/** Send one message; false when mail is not configured or the provider refused it. Never throws. */
export async function sendMail(mail: Mail, logger?: FastifyBaseLogger): Promise<boolean> {
  if (!mailConfigured()) return false;
  try {
    const res = process.env.BREVO_API_KEY ? await sendBrevo(mail) : await sendResend(mail);
    if (!res.ok) logger?.warn({ status: res.status, subject: mail.subject }, "mail-send-refused");
    return res.ok;
  } catch (err) {
    logger?.warn({ err: (err as Error).message, subject: mail.subject }, "mail-send-failed");
    return false;
  }
}

function sendBrevo(mail: Mail): Promise<Response> {
  const from = process.env.NEXUS_MAIL_FROM!;
  const named = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: named ? { name: named[1], email: named[2] } : { email: from.trim() },
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

function sendResend(mail: Mail): Promise<Response> {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.NEXUS_MAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}
