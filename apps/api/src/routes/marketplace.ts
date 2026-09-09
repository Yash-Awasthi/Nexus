// SPDX-License-Identifier: Apache-2.0
/**
 * Marketplace surface OWNER — extracted from api-bridge.ts (§16.7) and
 * reconciled onto the plugin registry (§16.2).
 *
 * The registry store (`pluginRegistryStore`, routes/plugin-registry.ts) is the
 * single source of truth for what exists in the marketplace: identity, name,
 * author, description, downloads, publish date. This module adds only the
 * UI-side extras — category, price, rating, tags, stars, installedBy — in its
 * own store (`marketplace_ui`), keyed by plugin id.
 *
 * Per-user identity: stars and installs are recorded per caller —
 * `request.nexusUserId` when auth resolves one (JWT sub / api_keys), else the
 * anonymous `"anon"` bucket (dev bypass, no auth configured). `view()` and
 * `/marketplace/me` are actor-scoped, so one user's star/install never leaks
 * into another's listing.
 *
 * Seeding: the six built-in showcase items are real manifests in the registry
 * (id `mp_1`…`mp_6`, version 1.0.0, `builtin://` entry), published idempotently
 * on registration. The UI list is then a projection over the registry, so
 * publishing via /api/v1/registry/plugins makes a plugin appear here too.
 */

import { validatePluginManifest, type PluginManifest } from "@nexus/plugin-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";

import { pluginRegistryStore, registryKeyOf, type RegistryRecord } from "./plugin-registry.js";

/** UI-only extras for one marketplace item (registry owns the rest). */
interface MpUiItem {
  id: string;
  category: string;
  price: "free" | "premium";
  rating: number;
  tags: string[];
  starredBy: string[];
  installedBy: string[];
}

const uiStore = new PersistentStore<MpUiItem>("marketplace_ui");

/**
 * Actor for star/install identity: the resolved user id when auth is
 * configured, else the anonymous bucket (dev bypass — routes are open).
 */
function actorOf(request: FastifyRequest): string {
  return request.nexusUserId ?? "anon";
}

// ── Built-in showcase items (seeded into the registry on registration) ────────

interface BuiltinSpec {
  id: string;
  name: string;
  author: string;
  description: string;
  category: string;
  downloads: number;
  rating: number;
  tags: string[];
  price: "free" | "premium";
}

const BUILTINS: BuiltinSpec[] = [
  {
    id: "mp_1",
    name: "Advanced Code Reviewer",
    author: "nexus-labs",
    description: "Multi-archetype code review with security and performance analysis",
    category: "development",
    downloads: 1247,
    rating: 4.8,
    tags: ["code-review", "security", "performance"],
    price: "free",
  },
  {
    id: "mp_2",
    name: "Legal Document Analyzer",
    author: "legaltech-co",
    description: "Contract analysis using ethicist and judge archetypes",
    category: "legal",
    downloads: 834,
    rating: 4.6,
    tags: ["legal", "contracts", "compliance"],
    price: "premium",
  },
  {
    id: "mp_3",
    name: "Market Research Suite",
    author: "bizinsights",
    description: "Market analysis with futurist and empiricist perspectives",
    category: "research",
    downloads: 2103,
    rating: 4.9,
    tags: ["market-research", "analysis"],
    price: "free",
  },
  {
    id: "mp_4",
    name: "Creative Writing Workshop",
    author: "wordcraft-ai",
    description: "Multi-perspective creative writing with iterative refinement",
    category: "creative",
    downloads: 567,
    rating: 4.3,
    tags: ["writing", "creative", "storytelling"],
    price: "free",
  },
  {
    id: "mp_5",
    name: "Tech Architecture Planner",
    author: "nexus-labs",
    description: "System design with architect and strategist archetypes",
    category: "development",
    downloads: 1892,
    rating: 4.7,
    tags: ["architecture", "system-design"],
    price: "premium",
  },
  {
    id: "mp_6",
    name: "Stakeholder Communication Kit",
    author: "comms-pro",
    description: "Stakeholder reports through empath and pragmatist lenses",
    category: "business",
    downloads: 421,
    rating: 4.4,
    tags: ["communication", "stakeholders"],
    price: "free",
  },
];

/** Publish the showcase builtins into the registry once (idempotent). */
async function ensureSeed(): Promise<void> {
  await pluginRegistryStore.load();
  await uiStore.load();
  const existing = new Set(Array.from(pluginRegistryStore.values()).map((r) => r.manifest.id));
  for (const b of BUILTINS) {
    if (existing.has(b.id)) continue;
    const manifest: PluginManifest = {
      id: b.id,
      name: b.name,
      version: "1.0.0",
      entry: `builtin://${b.id}`,
      capabilities: [],
      description: b.description,
      author: b.author,
      license: "Apache-2.0",
    };
    pluginRegistryStore.set(registryKeyOf(b.id, "1.0.0"), {
      manifest,
      publisher: "nexus-labs",
      downloads: b.downloads,
      // Stable timestamps so the showcase list order is deterministic.
      publishedAt: "2026-08-15T00:00:00.000Z",
    });
    uiStore.set(b.id, {
      id: b.id,
      category: b.category,
      price: b.price,
      rating: b.rating,
      tags: b.tags,
      starredBy: [],
      installedBy: [],
    });
  }
}

/** Latest record per plugin id (a registry holds every published version). */
function latestPerId(): RegistryRecord[] {
  const latest = new Map<string, RegistryRecord>();
  for (const record of pluginRegistryStore.values()) {
    const prev = latest.get(record.manifest.id);
    if (!prev || record.publishedAt > prev.publishedAt) {
      latest.set(record.manifest.id, record);
    }
  }
  return [...latest.values()];
}

/** Marketplace view: registry truth + UI extras, actor-scoped star/install. */
function view(
  record: { manifest: PluginManifest; downloads: number },
  ui: MpUiItem | undefined,
  actor: string,
) {
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    author: record.manifest.author ?? "unknown",
    description: record.manifest.description ?? "",
    category: ui?.category ?? "other",
    downloads: record.downloads,
    rating: ui?.rating ?? 0,
    tags: ui?.tags ?? [],
    price: ui?.price ?? "free",
    stars: ui?.starredBy.length ?? 0,
    installed: ui?.installedBy.includes(actor) ?? false,
    starred: ui?.starredBy.includes(actor) ?? false,
  };
}

function findRecord(id: string) {
  const matches = Array.from(pluginRegistryStore.values()).filter((r) => r.manifest.id === id);
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]!;
}

/** UI extras record for a plugin id, defaulted when absent. */
function uiFor(id: string): MpUiItem {
  return (
    uiStore.get(id) ?? {
      id,
      category: "other",
      price: "free",
      rating: 0,
      tags: [],
      starredBy: [],
      installedBy: [],
    }
  );
}

/**
 * Register the /marketplace surface. Called from apiBridgeRoutes (same /api/*
 * scope, same auth hooks as before the §16.7 extraction).
 */
export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  await ensureSeed();

  app.get<{ Querystring: { limit?: string; category?: string; q?: string } }>(
    "/marketplace",
    async (request, reply) => {
      const actor = actorOf(request);
      const { limit, category, q } = request.query;
      let items = latestPerId()
        .map((record) => view(record, uiStore.get(record.manifest.id), actor))
        .sort((a, b) => b.downloads - a.downloads);
      if (category && category !== "all") items = items.filter((i) => i.category === category);
      if (q) {
        const ql = q.toLowerCase();
        items = items.filter(
          (i) => i.name.toLowerCase().includes(ql) || i.description.toLowerCase().includes(ql),
        );
      }
      items = items.slice(0, parseInt(limit ?? "50") || 50);
      return reply.send({ items });
    },
  );

  app.get("/marketplace/me", async (request, reply) => {
    // Actor-scoped: only this caller's installed + starred plugin ids.
    const actor = actorOf(request);
    const installed: string[] = [];
    const starred: string[] = [];
    for (const ui of uiStore.values()) {
      if (ui.installedBy.includes(actor)) installed.push(ui.id);
      if (ui.starredBy.includes(actor)) starred.push(ui.id);
    }
    return reply.send({ installed, starred });
  });

  app.get<{ Params: { id: string } }>("/marketplace/:id", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    return reply.send({ item: view(record, uiStore.get(record.manifest.id), actorOf(request)) });
  });

  app.post<{ Params: { id: string } }>("/marketplace/:id/star", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const actor = actorOf(request);
    const ui = uiFor(record.manifest.id);
    if (!ui.starredBy.includes(actor)) ui.starredBy.push(actor);
    uiStore.set(ui.id, ui);
    return reply.send({ ok: true, stars: ui.starredBy.length });
  });

  app.delete<{ Params: { id: string } }>("/marketplace/:id/star", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const actor = actorOf(request);
    const ui = uiStore.get(record.manifest.id);
    if (ui) {
      ui.starredBy = ui.starredBy.filter((u) => u !== actor);
      uiStore.set(ui.id, ui);
    }
    // True post-operation count — idempotent: unstarring when the caller never
    // starred (or already unstarred) leaves both the store and the reported
    // count unchanged.
    return reply.send({ ok: true, stars: ui?.starredBy.length ?? 0 });
  });

  app.post<{ Params: { id: string } }>("/marketplace/:id/install", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const actor = actorOf(request);
    const ui = uiFor(record.manifest.id);
    if (!ui.installedBy.includes(actor)) ui.installedBy.push(actor);
    uiStore.set(ui.id, ui);
    // Registry telemetry: one owner for download counts too.
    record.downloads += 1;
    pluginRegistryStore.set(registryKeyOf(record.manifest.id, record.manifest.version), record);
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>("/marketplace/:id/install", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const actor = actorOf(request);
    const ui = uiStore.get(record.manifest.id);
    if (ui) {
      ui.installedBy = ui.installedBy.filter((u) => u !== actor);
      uiStore.set(ui.id, ui);
    }
    return reply.send({ ok: true });
  });

  app.post<{
    Body: { name: string; description: string; category: string; tags?: string[]; price?: string };
  }>("/marketplace", async (request, reply) => {
    const { name, description, category, tags = [], price = "free" } = request.body ?? {};
    if (!name || !description)
      return reply.code(400).send({ error: "name and description required" });
    const id = `mp_${Date.now()}`;
    // The registry is the owner — a marketplace publish is a registry publish
    // with a synthesized `builtin://` manifest (UI items aren't code).
    const manifest: PluginManifest = {
      id,
      name,
      version: "1.0.0",
      entry: `builtin://${id}`,
      capabilities: [],
      description,
      author: "you",
      license: "Apache-2.0",
    };
    try {
      validatePluginManifest(manifest);
    } catch (e) {
      const issues = (e as { issues?: string[] }).issues ?? [String(e)];
      return reply.code(400).send({ error: "invalid_manifest", issues });
    }
    const key = registryKeyOf(id, "1.0.0");
    if (pluginRegistryStore.has(key)) {
      return reply
        .code(409)
        .send({ error: "conflict", message: `plugin ${id}@1.0.0 already exists` });
    }
    const record = {
      manifest,
      publisher: "you",
      downloads: 0,
      publishedAt: new Date().toISOString(),
    };
    pluginRegistryStore.set(key, record);
    uiStore.set(id, {
      id,
      category: category ?? "other",
      price: (price === "premium" ? "premium" : "free") as "free" | "premium",
      rating: 0,
      tags,
      starredBy: [],
      installedBy: [],
    });
    return reply
      .code(201)
      .send({ ok: true, item: view(record, uiStore.get(id), actorOf(request)) });
  });
}
