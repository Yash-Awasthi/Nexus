// SPDX-License-Identifier: Apache-2.0
/**
 * Settings surface OWNER — extracted from api-bridge.ts.
 *
 * Per-user preferences (GET/POST/PATCH/PUT) and the per-user council roster, with
 * the same defaults and secret stripping the bridge used. The preference and
 * council stores stay bridge-owned because the chat stream reads them too, so
 * they are injected rather than duplicated.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { FastifyInstance } from "fastify";

import type { PersistentStore } from "../lib/persistent-store.ts";
import { listUserDrivers, listUserModels } from "../lib/provider-keys.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

/** Bridge-owned stores, defaults and validation the settings routes read. */
interface SettingsRoutesDeps {
  prefsStore: PersistentStore<Record<string, unknown>>;
  prefsDefaults: Record<string, unknown>;
  councilStore: {
    get(id: string): { members?: unknown; defaultTier?: string; updatedAt?: string } | undefined;
    set(id: string, value: { members: unknown; updatedAt: string }): void;
  };
  buildChatRegistry: (
    userId: string,
    providers: string[],
  ) => Promise<{ sources: Map<string, string> }>;
  validateCouncilMembers: (
    userId: string | undefined,
    members: unknown,
    sources: Map<string, string>,
  ) => Promise<unknown[]>;
}

const now = (): string => new Date().toISOString();
const userIdOf = (request: { nexusUserId?: string }): string => request.nexusUserId ?? "local";

/** Register /settings/preferences and /settings/council. */
export async function settingsRoutes(
  app: FastifyInstance,
  deps: SettingsRoutesDeps,
): Promise<void> {
  // -- SETTINGS --------------------------------------------------------------

  // Preferences are per-user (like council): preHandler attaches nexusUserId,
  // and each user's row lives in the persisted preferences store. A user who
  // never saved still gets deps.prefsDefaults via the GET merge.
  const _prefsPreHandler = { preHandler: requireAuthWithTier };

  app.get("/settings/preferences", _prefsPreHandler, async (request, reply) => {
    const uid = userIdOf(request);
    // Sane defaults for users who never saved, merged over their stored row.
    return reply.send({ ...deps.prefsDefaults, ...(deps.prefsStore.get(uid) ?? {}) });
  });

  app.post<{ Body: Record<string, unknown> }>(
    "/settings/preferences",
    _prefsPreHandler,
    async (request, reply) => {
      const uid = userIdOf(request);
      const merged = { ...(deps.prefsStore.get(uid) ?? {}), ...request.body };
      deps.prefsStore.set(uid, merged);
      return reply.send({ ...deps.prefsDefaults, ...merged });
    },
  );

  // Custom instructions (Profile page) persist in the same per-user store so
  // the chat stream can read them; previously PATCH /auth/me 400'd on the
  // field (the users table has no such column) and the save was a silent
  // no-op with a fake success toast.
  app.patch<{ Body: { customInstructions?: unknown } }>(
    "/settings/preferences",
    _prefsPreHandler,
    async (request, reply) => {
      const uid = userIdOf(request);
      if (typeof request.body?.customInstructions !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "customInstructions must be a string" });
      }
      const merged = {
        ...(deps.prefsStore.get(uid) ?? {}),
        customInstructions: request.body.customInstructions.slice(0, 2000),
      };
      deps.prefsStore.set(uid, merged);
      return reply.send({ ...deps.prefsDefaults, ...merged });
    },
  );

  // The settings page saves with PUT — accept it too (previously the UI's
  // PUT 404'd and every preference change was silently dropped).
  app.put<{ Body: Record<string, unknown> }>(
    "/settings/preferences",
    _prefsPreHandler,
    async (request, reply) => {
      const uid = userIdOf(request);
      const merged = { ...(deps.prefsStore.get(uid) ?? {}), ...request.body };
      deps.prefsStore.set(uid, merged);
      return reply.send({ ...deps.prefsDefaults, ...merged });
    },
  );

  // Per-user council config: keyed by the authenticated user so a user's
  // council follows them across browsers and survives server restarts.
  // Fresh users get the same sensible defaults the UI catalog ships.
  const _COUNCIL_SEED_MEMBERS = [
    {
      id: "chatgpt",
      label: "ChatGPT",
      enabled: true,
      mode: "api",
      provider: "openai",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      id: "gemini",
      label: "Gemini",
      enabled: true,
      mode: "api",
      provider: "gemini",
      model: "gemini-3.6-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    {
      id: "claude",
      label: "Claude",
      enabled: true,
      mode: "api",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    },
  ];

  /** Up to three providers the caller saved keys for; the catalogue seed when there are none. */
  const seedCouncil = async (userId: string | undefined) => {
    const drivers = await listUserDrivers(userId).catch(() => []);
    const named = new Map(
      (await listUserModels(userId).catch(() => [])).map((r) => [r.provider, r.models]),
    );
    const members = drivers.slice(0, 3).map(({ id, driver }) => ({
      id: `key-${id}`,
      label: id,
      enabled: true,
      mode: "api",
      provider: id,
      model: named.get(id)?.[0] ?? driver.model,
    }));
    return members.length > 0 ? members : _COUNCIL_SEED_MEMBERS;
  };

  app.get("/settings/council", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const uid = userIdOf(request);
    const stored = deps.councilStore.get(uid);
    const seed = stored ? _COUNCIL_SEED_MEMBERS : await seedCouncil(request.nexusUserId);
    const body = stored?.members ?? { members: seed };
    // Strip any legacy secret fields that may have been persisted before the
    // server-side sanitizer existed — never serve them back.
    const members = stripMemberSecrets((body as { members?: unknown } | null)?.members) ?? seed;
    // BYOK: report which key backs each member (saved key, linked account,
    // server env key, local Ollama, or none). Only the source label leaves the server.
    const { sources } = await deps.buildChatRegistry(
      uid,
      Array.isArray(members) ? members.map((m) => (m as { provider: string }).provider) : [],
    );
    const withSources = Array.isArray(members)
      ? members.map((m) => ({
          ...m,
          mode: "api",
          keySource: sources.get((m as { provider: string }).provider) ?? "none",
        }))
      : members;
    return reply.send({
      ...(stored ?? { defaultTier: "fast" }),
      ...(typeof body === "object" && body !== null ? body : {}),
      members: withSources,
      seeded: !stored,
    });
  });

  // Defense-in-depth: member objects must never carry secret material into the
  // persistent store. The UI strips apiKey client-side; the server strips it
  // again (recursively) so a legacy/buggy client cannot plant plaintext keys
  // into nexus_kv and have them echoed back by GET.
  const SECRET_MEMBER_KEYS = new Set(["apiKey", "api_key", "apiSecret", "secret", "password"]);
  function stripMemberSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripMemberSecrets);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_MEMBER_KEYS.has(k) || k === "__proto__") continue;
        out[k] = stripMemberSecrets(v);
      }
      return out;
    }
    return value;
  }

  // Shared save path: persist per-user, then run best-effort per-member model
  // validation so the UI can surface actionable hints for unavailable models.
  const saveCouncilConfig = async (
    uid: string,
    body: unknown,
  ): Promise<{ ok: true; validations: unknown[]; keySources: unknown[] }> => {
    deps.councilStore.set(uid, {
      members: stripMemberSecrets(body),
      updatedAt: now(),
    });
    const members = (body as { members?: unknown } | null)?.members;
    const list = Array.isArray(members) ? (members as { provider: string }[]) : [];
    const { sources } = await deps.buildChatRegistry(
      uid,
      list.map((m) => m.provider),
    );
    const validations = await deps.validateCouncilMembers(uid, members, sources);
    const keySources = list.map((m, index) => ({
      index,
      source: sources.get(m.provider) ?? "none",
    }));
    return { ok: true, validations, keySources };
  };

  // POST: legacy consumers (kept for compat). PUT: the Settings page.
  app.post<{ Body: unknown }>(
    "/settings/council",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      return reply.send(await saveCouncilConfig(userIdOf(request), request.body));
    },
  );

  app.put<{ Body: unknown }>(
    "/settings/council",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      return reply.send(await saveCouncilConfig(userIdOf(request), request.body));
    },
  );
}
