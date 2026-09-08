// SPDX-License-Identifier: Apache-2.0
/**
 * API tokens surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * In-memory API token store with byte-identical response shapes: each token
 * is SHA-256 hashed for safe listing, and the raw `nxk_` value is returned
 * only at creation time.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import { sha256hex } from "../lib/crypto-utils.js";

const now = (): string => new Date().toISOString();

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

const _apiTokens = new Map<string, ApiToken>();

/** Register the /tokens surface. Called from apiBridgeRoutes. */
export async function tokensRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tokens", async (_req, reply) => {
    return reply.send({
      tokens: Array.from(_apiTokens.values()).map(
        ({ id, name, prefix, scopes, createdAt, lastUsedAt }) => ({
          id,
          name,
          prefix,
          scopes,
          createdAt,
          lastUsedAt,
        }),
      ),
    });
  });

  app.post<{ Body: { name: string; scopes?: string[] } }>("/tokens", async (request, reply) => {
    const raw = `nxk_${crypto.randomBytes(24).toString("hex")}`;
    const hash = sha256hex(raw);
    const id = crypto.randomUUID();
    const entry: ApiToken = {
      id,
      name: request.body.name,
      prefix: raw.slice(0, 10),
      hash,
      scopes: request.body.scopes ?? ["*"],
      createdAt: now(),
      lastUsedAt: null,
    };
    _apiTokens.set(id, entry);
    return reply.code(201).send({
      id,
      name: entry.name,
      token: raw,
      prefix: entry.prefix,
      scopes: entry.scopes,
      createdAt: entry.createdAt,
    });
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (request, reply) => {
    if (!_apiTokens.has(request.params.id))
      return reply.code(404).send({ error: "Token not found" });
    _apiTokens.delete(request.params.id);
    return reply.code(204).send();
  });
}