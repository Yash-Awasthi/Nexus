// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge-base surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * The whole /kb surface: listing (PersistentStore-backed), CRUD, documents,
 * and the KG-ingestion alias POST /kb/:id. Response shapes are byte-identical
 * to the pre-extraction handlers.
 *
 * The KG helper (`getKG`) is injected rather than imported — it stays
 * bridge-owned because /kg/* and the intel surfaces share its store.
 *
 * Known inert branch (kept byte-identical for the extraction): the
 * ingestion alias POST /kb/:id calls kg.ingest with the bridge's default
 * KnowledgeGraph, whose extractors default to no-ops — it returns zero
 * entities/relationships. Wiring real extractors (e.g. @nexus/nlp-utils)
 * is a separate enhancement slice.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { KnowledgeGraph } from "@nexus/knowledge-graph";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";

const now = (): string => new Date().toISOString();

const _kbStore = new PersistentStore<{
  id: string;
  name: string;
  description: string;
  docCount: number;
  createdAt: string;
  documents: { id: string; name: string; size: string; type: string }[];
}>("kb");

function getDocTypeFromName(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
  return "md";
}

/** Bridge-owned KG helper handed in at registration (no circular import). */
export interface KbRoutesDeps {
  getKG: () => KnowledgeGraph;
}

/** Register the /kb surface. Called from apiBridgeRoutes. */
export async function kbRoutes(app: FastifyInstance, deps: KbRoutesDeps): Promise<void> {
  await _kbStore.load();

  // GET /kb serves the KB store; the KG ingestion alias lives under POST /kb/:id.
  app.get("/kb", async (_req, reply) => {
    const kbs = [..._kbStore.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((kb) => ({ ...kb, docCount: kb.documents.length }));
    return reply.send({ kbs, total: kbs.length });
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/kb/:id",
    async (request, reply) => {
      const kg = deps.getKG();
      const result = await kg.ingest(request.body.text, { source: request.params.id });
      return reply.code(201).send(result);
    },
  );

  app.post<{ Body: { name: string; description?: string } }>("/kb", async (request, reply) => {
    const id = crypto.randomUUID();
    const kb = {
      id,
      name: request.body.name ?? "KB",
      description: request.body.description ?? "",
      docCount: 0,
      createdAt: now(),
      documents: [],
    };
    _kbStore.set(id, kb);
    return reply.code(201).send(kb);
  });

  app.delete<{ Params: { id: string } }>("/kb/:id", async (request, reply) => {
    _kbStore.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/kb/:id/documents", async (request, reply) => {
    const kb = _kbStore.get(request.params.id);
    return reply.send({ documents: kb?.documents ?? [], total: kb?.documents.length ?? 0 });
  });

  app.post<{ Params: { id: string }; Body: { name: string; size?: string } }>(
    "/kb/:id/documents",
    async (request, reply) => {
      const kb = _kbStore.get(request.params.id);
      if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
      const doc = {
        id: "doc_" + crypto.randomUUID(),
        name: request.body.name ?? "untitled",
        size: request.body.size ?? "0 KB",
        type: getDocTypeFromName(request.body.name ?? ""),
      };
      kb.documents.push(doc);
      _kbStore.set(kb.id, kb);
      return reply.code(201).send(doc);
    },
  );

  app.delete<{ Params: { id: string; docId: string } }>(
    "/kb/:id/documents/:docId",
    async (request, reply) => {
      const kb = _kbStore.get(request.params.id);
      if (kb) {
        kb.documents = kb.documents.filter((d) => d.id !== request.params.docId);
        _kbStore.set(kb.id, kb);
      }
      return reply.code(204).send();
    },
  );
}
