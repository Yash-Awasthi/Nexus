// SPDX-License-Identifier: Apache-2.0
/**
 * §16.2 — Server-side hosted plugin registry (the marketplace's single owner).
 *
 * Implements the wire contract `PluginRegistryClient` (@nexus/plugin-sdk)
 * already speaks:
 *   GET    /registry/plugins          → { plugins: [{manifest, downloads, publishedAt}] }
 *   GET    /registry/plugins?q=…      → same, filtered by id/name/description
 *   GET    /registry/plugins/:id      → { manifest, downloads, publishedAt }
 *   POST   /registry/plugins          → publish (validated fail-closed; 409 on id+version)
 *   DELETE /registry/plugins/:id      → unpublish (author-only in this slice)
 *
 * Every manifest crossing the wire — inbound or outbound — passes through
 * `validatePluginManifest`, so malformed data fails closed on both sides.
 * Storage is a per-process PersistentStore ("plugin_registry") following the
 * repo's durable-KV convention; a Postgres migration is a later slice.
 *
 * The api-bridge `_mpItems` marketplace (UI-facing showcase) is intentionally
 * separate UI state; §16.2's goal is one OWNER for registry truth — the UI can
 * later read from here instead of duplicating it.
 */

import {
  validatePluginManifest,
  type PluginManifest,
} from "@nexus/plugin-sdk";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";
import { requireAuthWithTier } from "../middleware/auth.js";

export interface RegistryRecord {
  manifest: PluginManifest;
  /** Publisher identity (nexusUserId when auth resolves one, else "anon"). */
  publisher: string;
  downloads: number;
  publishedAt: string;
}

/**
 * The registry store — SINGLE owner of plugin truth (§16.2). The marketplace
 * module reads/seeds it (UI projection) and bumps download counters on
 * install; publish/unpublish stay in this file's wire contract.
 */
export const pluginRegistryStore = new PersistentStore<RegistryRecord>("plugin_registry");

/** Composite key: id + version (a registry holds every published version). */
export const registryKeyOf = (id: string, version: string): string => `${id}@${version}`;

const store = pluginRegistryStore;
const keyOf = registryKeyOf;

function view(r: RegistryRecord) {
  return { manifest: r.manifest, downloads: r.downloads, publishedAt: r.publishedAt };
}

export async function pluginRegistryRoutes(app: FastifyInstance): Promise<void> {
  await store.load();

  /** GET /registry/plugins?q= — list (validated on the way out too). */
  app.get<{ Querystring: { q?: string } }>(
    "/registry/plugins",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const q = request.query.q?.toLowerCase();
      let records = Array.from(store.values());
      if (q) {
        records = records.filter(
          (r) =>
            r.manifest.id.toLowerCase().includes(q) ||
            r.manifest.name.toLowerCase().includes(q) ||
            (r.manifest.description ?? "").toLowerCase().includes(q),
        );
      }
      // Latest version per id, newest publish first.
      const latest = new Map<string, RegistryRecord>();
      for (const r of records) {
        const prev = latest.get(r.manifest.id);
        if (!prev || r.publishedAt > prev.publishedAt) latest.set(r.manifest.id, r);
      }
      const plugins = [...latest.values()]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .map(view);
      return reply.send({ plugins });
    },
  );

  /** GET /registry/plugins/:id — latest version of one plugin. */
  app.get<{ Params: { id: string } }>(
    "/registry/plugins/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const records = Array.from(store.values()).filter(
        (r) => r.manifest.id === request.params.id,
      );
      if (records.length === 0) return reply.code(404).send({ error: "not found" });
      const latest = records.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]!;
      return reply.send(view(latest));
    },
  );

  /** POST /registry/plugins — publish (fail-closed manifest validation). */
  app.post<{ Body: { manifest: unknown } }>(
    "/registry/plugins",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      let manifest: PluginManifest;
      try {
        manifest = validatePluginManifest(request.body?.manifest);
      } catch (e) {
        // Mirror the SDK's fail-closed contract: the client gets the same
        // PluginManifestError semantics as a local loadPlugin failure.
        const issues = (e as { issues?: string[] }).issues ?? [String(e)];
        return reply.code(400).send({ error: "invalid_manifest", issues });
      }
      const key = keyOf(manifest.id, manifest.version);
      if (store.has(key)) {
        return reply.code(409).send({
          error: "conflict",
          message: `plugin ${manifest.id}@${manifest.version} already exists`,
        });
      }
      const record: RegistryRecord = {
        manifest,
        publisher: request.nexusUserId ?? "anon",
        downloads: 0,
        publishedAt: new Date().toISOString(),
      };
      store.set(key, record);
      return reply.code(201).send(view(record));
    },
  );

  /** DELETE /registry/plugins/:id — unpublish every version (publisher-only). */
  app.delete<{ Params: { id: string } }>(
    "/registry/plugins/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const records = Array.from(store.values()).filter(
        (r) => r.manifest.id === request.params.id,
      );
      if (records.length === 0) return reply.code(404).send({ error: "not found" });
      const caller = request.nexusUserId ?? "anon";
      const foreign = records.filter((r) => r.publisher !== caller && caller !== "admin");
      if (foreign.length > 0) {
        return reply.code(403).send({ error: "forbidden", message: "not the publisher" });
      }
      for (const r of records) store.delete(keyOf(r.manifest.id, r.manifest.version));
      return reply.code(204).send();
    },
  );

  /** POST /registry/plugins/:id/install — download counter (install telemetry). */
  app.post<{ Params: { id: string } }>(
    "/registry/plugins/:id/install",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const records = Array.from(store.values()).filter(
        (r) => r.manifest.id === request.params.id,
      );
      if (records.length === 0) return reply.code(404).send({ error: "not found" });
      const latest = records.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]!;
      latest.downloads += 1;
      store.set(keyOf(latest.manifest.id, latest.manifest.version), latest);
      return reply.send({ ok: true, downloads: latest.downloads });
    },
  );
}
