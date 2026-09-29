// SPDX-License-Identifier: Apache-2.0
/**
 * The refresh cookie, and how a sign-in callback hands its session over.
 *
 * A browser that lands on a callback gets the refresh token as an httpOnly
 * cookie and is sent into the app, so no token appears in a URL, the page or
 * the request log. The desktop app fetches the callback itself and keeps the
 * JSON answer.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The browser keeps its refresh token in this cookie, out of reach of page
 * scripts; API clients keep sending it in the body instead.
 */
const REFRESH_COOKIE = "nexus_refresh";

export function setRefreshCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string | null,
): void {
  const attrs = [
    `${REFRESH_COOKIE}=${token ?? ""}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/v1/auth",
    `Max-Age=${token ? Math.floor(REFRESH_TOKEN_TTL_MS / 1000) : 0}`,
    ...(request.protocol === "https" ? ["Secure"] : []),
  ];
  reply.header("Set-Cookie", attrs.join("; "));
}

export function refreshCookie(request: FastifyRequest): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === REFRESH_COOKIE && value.length) return value.join("=") || undefined;
  }
  return undefined;
}

/** A page navigation asks for HTML; the desktop app's fetch and API clients do not. */
export function isBrowserNavigation(request: FastifyRequest): boolean {
  return (request.headers.accept ?? "").includes("text/html");
}

/** Where the sign-in page picks the session up from the cookie. */
export function signedInUrl(appBase = "", next?: string): string {
  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : undefined;
  return `${appBase}/login?signed_in=1${safeNext ? `&next=${encodeURIComponent(safeNext)}` : ""}`;
}

/** Answer a finished sign-in: the cookie and a redirect for a browser, JSON for anything else. */
export function finishSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  refreshToken: string,
  body: Record<string, unknown>,
  { appBase = "", next }: { appBase?: string; next?: string } = {},
): FastifyReply {
  if (!isBrowserNavigation(request)) return reply.send(body);
  setRefreshCookie(request, reply, refreshToken);
  return reply.redirect(signedInUrl(appBase, next), 302);
}

/** Answer a failed sign-in: back to the sign-in page for a browser, the error as JSON otherwise. */
export function failSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: { error: string } & Record<string, unknown>,
  appBase = "",
): FastifyReply {
  if (isBrowserNavigation(request)) {
    return reply.redirect(`${appBase}/login?error=${encodeURIComponent(body.error)}`, 302);
  }
  return reply.code(status).send(body);
}
