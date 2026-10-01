// SPDX-License-Identifier: Apache-2.0
/** POST /api/v1/channels — open a stream channel; the sockets live at /api/ws/channels/:id. */
import type { FastifyInstance } from "fastify";

import { createChannel } from "../lib/channels.js";
import { requireAuth } from "../middleware/auth.js";

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  app.post("/channels", { preHandler: requireAuth }, async (_request, reply) =>
    reply.code(201).send(createChannel()),
  );
}
