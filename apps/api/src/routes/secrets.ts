// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets
 *   GET    /api/v1/secrets              — names and metadata, never values
 *   PUT    /api/v1/secrets/:name        — store or rotate one
 *   DELETE /api/v1/secrets/:name
 *   GET    /api/v1/secrets/requests     — what is waiting to be filled in
 *   POST   /api/v1/secrets/requests     — an agent says what it needs, and why
 *   DELETE /api/v1/secrets/requests/:id — withdraw a request
 *
 * No route here returns a secret value. Not a masked one, not the first few
 * characters: the fingerprint is there so an owner can confirm a rotation
 * happened, and that is the whole read surface. Server-side consumers call
 * `resolveSecret` in-process.
 *
 * The request flow exists so an agent never has to ask for a secret in
 * conversation. It records the name and the reason; the owner supplies the
 * value through `PUT`, which closes the request.
 */

import type { FastifyInstance } from "fastify";

import { ownerIdFor } from "../lib/owner.js";
import {
  SecretEncryptionUnavailableError,
  cancelSecretRequest,
  deleteSecret,
  isValidSecretName,
  listSecretRequests,
  listSecrets,
  loadSecretStore,
  putSecret,
  requestSecret,
} from "../lib/secret-store.js";
import { requireAuthWithTier } from "../middleware/auth.js";

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  await loadSecretStore();

  app.get("/secrets", { preHandler: requireAuthWithTier }, async (request, reply) => {
    return reply.send({ secrets: listSecrets(ownerIdFor(request)) });
  });

  app.put<{ Params: { name: string }; Body: { value?: string; description?: string } }>(
    "/secrets/:name",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const { name } = request.params;
      if (!isValidSecretName(name)) {
        return reply.code(400).send({
          error: "invalid_name",
          message: "A secret name is uppercase letters, digits and underscores, e.g. STRIPE_KEY.",
        });
      }
      const value = request.body?.value;
      if (typeof value !== "string" || value.length === 0) {
        return reply.code(400).send({ error: "value_required" });
      }

      try {
        const metadata = putSecret(ownerIdFor(request), name, value, request.body?.description);
        return reply.send({ secret: metadata });
      } catch (err) {
        if (err instanceof SecretEncryptionUnavailableError) {
          // 503 rather than 500: the deployment is missing a key, which an
          // operator can fix, and nothing was written.
          return reply.code(503).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { name: string } }>(
    "/secrets/:name",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const removed = deleteSecret(ownerIdFor(request), request.params.name);
      if (!removed) return reply.code(404).send({ error: "not_found" });
      return reply.send({ deleted: true });
    },
  );

  app.get("/secrets/requests", { preHandler: requireAuthWithTier }, async (request, reply) => {
    return reply.send({ requests: listSecretRequests(ownerIdFor(request)) });
  });

  app.post<{ Body: { name?: string; reason?: string } }>(
    "/secrets/requests",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const name = request.body?.name ?? "";
      const reason = (request.body?.reason ?? "").trim();
      if (!isValidSecretName(name)) {
        return reply.code(400).send({ error: "invalid_name" });
      }
      if (!reason) {
        // A request with no reason is one the owner cannot judge.
        return reply.code(400).send({ error: "reason_required" });
      }
      return reply
        .code(201)
        .send({ request: requestSecret(ownerIdFor(request), name, reason.slice(0, 500)) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/secrets/requests/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const cancelled = cancelSecretRequest(ownerIdFor(request), request.params.id);
      if (!cancelled) return reply.code(404).send({ error: "not_found" });
      return reply.send({ request: cancelled });
    },
  );
}
