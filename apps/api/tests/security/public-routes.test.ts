// SPDX-License-Identifier: Apache-2.0
/**
 * The /api/v1 scope has no scope-wide auth hook, so a route there is public unless one of its
 * preHandlers is a `require*` guard. Every public one must be listed here on purpose (NX-FEAT-007).
 */
import type { RouteOptions } from "fastify";
import { beforeAll, expect, it, vi } from "vitest";

const { seen } = vi.hoisted(() => ({ seen: [] as (RouteOptions & { prefix?: string })[] }));

vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const wrapped = ((opts?: Parameters<typeof mod.default>[0]) => {
    const app = mod.default(opts);
    app.addHook("onRoute", (route) => {
      seen.push(route);
    });
    return app;
  }) as typeof mod.default;
  return { ...mod, default: wrapped, fastify: wrapped };
});

const PUBLIC_V1 = new Set<string>([
  // Account lifecycle before a session exists.
  "POST /api/v1/auth/register",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/forgot-password",
  "POST /api/v1/auth/reset-password",
  "POST /api/v1/auth/verify-email",
  // Single sign-on entry points and callbacks (state / SAML InResponseTo verified in-handler).
  "GET /api/v1/oauth/providers",
  "GET /api/v1/oauth/google",
  "GET /api/v1/oauth/google/callback",
  "GET /api/v1/oauth/github",
  "GET /api/v1/oauth/github/callback",
  "GET /api/v1/oauth/slack",
  "GET /api/v1/oauth/slack/callback",
  "GET /api/v1/auth/oidc/authorize",
  "GET /api/v1/auth/oidc/callback",
  "GET /api/v1/auth/saml/login",
  "GET /api/v1/auth/saml/metadata",
  "POST /api/v1/auth/saml/callback",
  "GET /api/v1/llm-oauth/providers",
  "GET /api/v1/llm-oauth/:provider/callback",
  "GET /api/v1/connectors/:id/oauth/callback",
  // Browsers send CSP violation reports without credentials.
  "POST /api/v1/csp-report",
  // SCIM discovery documents (RFC 7644 lets these be public).
  "GET /api/v1/scim/v2/ServiceProviderConfig",
  "GET /api/v1/scim/v2/Schemas",
  // Webhooks that verify their sender in-handler.
  "POST /api/v1/bots/slack/events",
  "POST /api/v1/bots/teams/activity",
  "POST /api/v1/bots/telegram/webhook",
  "POST /api/v1/org/hooks/:hookId",
  // Signed links.
  "GET /api/v1/drive/file",
  "GET /api/v1/brief/:domain/share/:digest",
  // Deliberately public, bounded by their own limits.
  "GET /api/v1/libertas",
  "POST /api/v1/libertas/complete",
  "GET /api/v1/mcp/info",
]);

const isGuard = (fn: unknown) => typeof fn === "function" && /^require/.test(fn.name);

let publicRoutes: string[] = [];

beforeAll(async () => {
  const { buildServer } = await import("../../src/server.ts");
  const app = await buildServer();
  await app.ready();
  publicRoutes = seen
    .filter((r) => r.url.startsWith("/api/v1/") && (r.prefix ?? "").startsWith("/api/v1"))
    .filter((r) => !([] as unknown[]).concat(r.preHandler ?? []).some(isGuard))
    .flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((m) => `${m} ${r.url}`))
    .filter((r) => !r.startsWith("HEAD "));
  await app.close();
}, 120_000);

it("lists every public /api/v1 route", () => {
  expect(publicRoutes.filter((r) => !PUBLIC_V1.has(r)).sort()).toEqual([]);
});

it("lists no route that has since gained a guard", () => {
  expect([...PUBLIC_V1].filter((r) => !publicRoutes.includes(r)).sort()).toEqual([]);
});
