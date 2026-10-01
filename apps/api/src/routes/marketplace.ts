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

import {
  ANON_OWNER,
  createArchetype,
  deleteArchetype,
  listArchetypes,
  loadArchetypeStore,
  type ArchetypeInput,
} from "../lib/archetype-store.js";
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
  type?: ItemType;
  /** Archetype system prompt, prompt text, workflow steps (JSON) or skill code. */
  content?: string;
  /** Built-in persona ids a built-in lineup is made of. */
  archetypeIds?: string[];
  publisherId?: string;
  /** What each installer received, so uninstall removes exactly that. */
  installedRows?: Record<string, string[]>;
}

const ITEM_TYPES = ["archetype", "workflow", "prompt", "skill"] as const;
type ItemType = (typeof ITEM_TYPES)[number];

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
  tags: string[];
  archetypeIds: string[];
}

const BUILTINS: BuiltinSpec[] = [
  {
    id: "mp_1",
    name: "Advanced Code Reviewer",
    author: "nexus",
    description: "Multi-archetype code review with security and performance analysis",
    category: "development",
    tags: ["code-review", "security", "performance"],
    archetypeIds: ["architect", "empiricist", "contrarian", "minimalist"],
  },
  {
    id: "mp_2",
    name: "Legal Document Analyzer",
    author: "nexus",
    description: "Contract analysis using ethicist and judge archetypes",
    category: "legal",
    tags: ["legal", "contracts", "compliance"],
    archetypeIds: ["ethicist", "judge", "historian"],
  },
  {
    id: "mp_3",
    name: "Market Research Suite",
    author: "nexus",
    description: "Market analysis with futurist and empiricist perspectives",
    category: "research",
    tags: ["market-research", "analysis"],
    archetypeIds: ["futurist", "empiricist", "strategist"],
  },
  {
    id: "mp_4",
    name: "Creative Writing Workshop",
    author: "nexus",
    description: "Multi-perspective creative writing with iterative refinement",
    category: "creative",
    tags: ["writing", "creative", "storytelling"],
    archetypeIds: ["creator", "outsider", "contrarian"],
  },
  {
    id: "mp_5",
    name: "Tech Architecture Planner",
    author: "nexus",
    description: "System design with architect and strategist archetypes",
    category: "development",
    tags: ["architecture", "system-design"],
    archetypeIds: ["architect", "strategist", "pragmatist"],
  },
  {
    id: "mp_6",
    name: "Stakeholder Communication Kit",
    author: "nexus",
    description: "Stakeholder reports through empath and pragmatist lenses",
    category: "business",
    tags: ["communication", "stakeholders"],
    archetypeIds: ["empath", "pragmatist", "strategist"],
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
      publisher: "nexus",
      downloads: 0,
      // Stable timestamps so the showcase list order is deterministic.
      publishedAt: "2026-08-15T00:00:00.000Z",
    });
    uiStore.set(b.id, {
      id: b.id,
      category: b.category,
      price: "free",
      rating: 0,
      tags: b.tags,
      starredBy: [],
      installedBy: [],
    });
  }
  // Lineups are attached on every start so rows seeded before they existed get them.
  for (const b of BUILTINS) {
    const ui = uiStore.get(b.id);
    if (ui && !ui.archetypeIds) uiStore.set(b.id, { ...ui, archetypeIds: b.archetypeIds });
  }
}

/** Built-in personas as inputs for the installer's own archetypes. */
function builtinLineup(ids: string[], owner: string): ArchetypeInput[] {
  const builtins = listArchetypes(owner).filter((r) => r.builtin);
  return ids
    .map((id) => builtins.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map(({ id: _id, ownerId: _o, builtin: _b, createdAt: _c, ...input }) => input);
}

/** Workflow steps from published content: a JSON array, or an object with `steps`. */
function parseSteps(content: string): unknown[] | null {
  try {
    const v = JSON.parse(content) as unknown;
    if (Array.isArray(v)) return v;
    const steps = (v as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps : null;
  } catch {
    return null;
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
    type: ui?.type ?? "archetype",
    installs: record.downloads,
    isMine: !!ui?.publisherId && ui.publisherId === actor,
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
  await Promise.all([ensureSeed(), loadArchetypeStore()]);

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

  /** Create what an item holds in the caller's own workspace; returns the created ids. */
  async function installInto(
    request: FastifyRequest,
    record: { manifest: PluginManifest },
    ui: MpUiItem,
  ): Promise<string[]> {
    const owner = request.nexusUserId ?? ANON_OWNER;
    const name = record.manifest.name;
    const description = record.manifest.description ?? "";
    const content = ui.content ?? "";
    const create = async (url: string, payload: Record<string, unknown>) => {
      const res = await app.inject({
        method: "POST",
        url,
        payload,
        headers: request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {},
      });
      if (res.statusCode >= 300) throw new Error(`Could not install ${name} (${res.statusCode})`);
      return String(res.json<{ id: unknown }>().id);
    };
    switch (ui.type ?? "archetype") {
      case "prompt":
        return [`prompt:${await create("/api/prompts", { name, description, content })}`];
      case "workflow":
        return [
          `workflow:${await create("/api/workflows", { name, steps: parseSteps(content) ?? [] })}`,
        ];
      case "skill":
        return [`skill:${await create("/api/skills", { name, description, code: content })}`];
      default: {
        const inputs = ui.archetypeIds?.length
          ? builtinLineup(ui.archetypeIds, owner)
          : [{ name, description, systemPrompt: content, thinkingStyle: "" }];
        return inputs.map((input) => `archetype:${createArchetype(owner, input).id}`);
      }
    }
  }

  async function uninstallFrom(request: FastifyRequest, rows: string[]): Promise<void> {
    const owner = request.nexusUserId ?? ANON_OWNER;
    for (const row of rows) {
      const [kind, id] = [row.slice(0, row.indexOf(":")), row.slice(row.indexOf(":") + 1)];
      if (kind === "archetype") {
        deleteArchetype(owner, id);
        continue;
      }
      await app.inject({
        method: "DELETE",
        url: `/api/${kind}s/${encodeURIComponent(id)}`,
        headers: request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {},
      });
    }
  }

  app.post<{ Params: { id: string } }>("/marketplace/:id/install", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const actor = actorOf(request);
    const ui = uiFor(record.manifest.id);
    if (ui.installedBy.includes(actor)) return reply.send({ ok: true, created: 0 });
    let rows: string[];
    try {
      rows = await installInto(request, record, ui);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
    ui.installedBy.push(actor);
    ui.installedRows = { ...ui.installedRows, [actor]: rows };
    uiStore.set(ui.id, ui);
    // Registry telemetry: one owner for download counts too.
    record.downloads += 1;
    pluginRegistryStore.set(registryKeyOf(record.manifest.id, record.manifest.version), record);
    return reply.send({ ok: true, created: rows.length });
  });

  app.delete<{ Params: { id: string } }>("/marketplace/:id/install", async (request, reply) => {
    const record = findRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const actor = actorOf(request);
    const ui = uiStore.get(record.manifest.id);
    if (ui) {
      await uninstallFrom(request, ui.installedRows?.[actor] ?? []);
      ui.installedBy = ui.installedBy.filter((u) => u !== actor);
      if (ui.installedRows) delete ui.installedRows[actor];
      uiStore.set(ui.id, ui);
    }
    return reply.send({ ok: true });
  });

  app.post<{
    Body: {
      name: string;
      description: string;
      category?: string;
      tags?: string[];
      type?: string;
      content?: string;
    };
  }>("/marketplace", async (request, reply) => {
    const { name, description, category, tags = [] } = request.body ?? {};
    if (!name || !description)
      return reply.code(400).send({ error: "name and description required" });
    const type = (ITEM_TYPES as readonly string[]).includes(request.body.type ?? "archetype")
      ? ((request.body.type ?? "archetype") as ItemType)
      : null;
    if (!type)
      return reply.code(400).send({ error: `type must be one of ${ITEM_TYPES.join(", ")}` });
    const content = (request.body.content ?? "").slice(0, 200_000);
    if (!content.trim()) {
      return reply.code(400).send({ error: "content is required — it is what installers receive" });
    }
    if (type === "workflow" && !parseSteps(content)) {
      return reply.code(400).send({ error: "workflow content must be JSON: an array of steps" });
    }
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
      category: category ?? type,
      price: "free",
      rating: 0,
      tags,
      starredBy: [],
      installedBy: [],
      type,
      content,
      publisherId: actorOf(request),
    });
    return reply
      .code(201)
      .send({ ok: true, item: view(record, uiStore.get(id), actorOf(request)) });
  });
}
