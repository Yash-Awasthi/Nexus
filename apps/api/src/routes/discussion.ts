// SPDX-License-Identifier: Apache-2.0
/**
 * Discussion routes
 *   POST /api/v1/discussion/stream — SSE: ledger entries as they land
 *
 * The third council shape (`runDiscussion` in @nexus/council). Unlike the vote
 * and the debate, participants here are not round-locked: each reads the shared
 * ledger from its own watermark and contributes on its own clock, and a
 * supervisor keeps the record and decides when the result has arrived.
 *
 * Personas and per-member models come from the same archetype registry the
 * other two paths resolve against.
 *
 * ponytail: the ledger lives only for the life of the stream — it is streamed
 * entry by entry and returned whole in the `done` frame, but a client that
 * disconnects loses it. Upgrade path is a PersistentStore keyed by discussion
 * id, in the shape of lib/archetype-store.ts.
 */

import {
  detectTaskCategory,
  runDiscussion,
  type DebateMember,
  type IStreamingTransport,
} from "@nexus/council";
import type { LlmRole } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";

import { ANON_OWNER, loadArchetypeStore, resolveCouncilMembers } from "../lib/archetype-store.js";
import { buildUserDriverRegistry } from "../lib/provider-keys.js";
import { requireAuthWithTier } from "../middleware/auth.js";

import { resolveCouncilModelAlias, resolveMemberModel } from "./council.js";

/** Caps a caller may lower but not raise. */
const LIMITS = {
  participants: 6,
  contributions: 40,
  wallMs: 600_000,
  settlePauseMs: 30_000,
} as const;

interface DiscussionBody {
  topic: string;
  participants: { label: string; provider: string; model: string }[];
  /** Council alias, `provider/model`, or a bare model id. */
  supervisorModel?: string;
  settlePauseMs?: number;
  maxContributions?: number;
  maxWallMs?: number;
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.round(value ?? fallback)));

export async function discussionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DiscussionBody }>(
    "/discussion/stream",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["topic", "participants"],
          properties: {
            topic: { type: "string", minLength: 1, maxLength: 10_000 },
            participants: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["label", "provider", "model"],
                properties: {
                  label: { type: "string", minLength: 1 },
                  provider: { type: "string", minLength: 1 },
                  model: { type: "string", minLength: 1 },
                },
              },
            },
            supervisorModel: { type: "string" },
            settlePauseMs: { type: "number", minimum: 0 },
            maxContributions: { type: "number", minimum: 1 },
            maxWallMs: { type: "number", minimum: 1_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const requested = body.participants.slice(0, LIMITS.participants);

      const supervisorChoice = body.supervisorModel ?? resolveCouncilModelAlias();
      let supervisorTarget = resolveMemberModel(supervisorChoice);
      if (!supervisorTarget) {
        return reply.code(400).send({
          error: "unknown_supervisor_model",
          message: `Unknown model "${supervisorChoice}".`,
        });
      }

      const providers = [
        ...new Set([...requested.map((p) => p.provider), supervisorTarget.provider]),
      ];
      const { registry } = await buildUserDriverRegistry(request.nexusUserId, providers);

      const available = requested.filter((p) => registry.get(p.provider));
      // With no supervisor asked for, one the caller cannot reach falls back to
      // a participant's model rather than refusing the discussion.
      if (!body.supervisorModel && !registry.get(supervisorTarget.provider) && available[0]) {
        supervisorTarget = { provider: available[0].provider, model: available[0].model };
      }
      if (available.length === 0 || !registry.get(supervisorTarget.provider)) {
        return reply.code(400).send({
          error: "no_provider_key",
          message:
            "No configured provider covers the requested participants and supervisor. " +
            "Add a key under Settings → Provider Keys.",
        });
      }

      await loadArchetypeStore();
      const personas = resolveCouncilMembers(
        request.nexusUserId ?? ANON_OWNER,
        detectTaskCategory(body.topic),
        available.length,
      );
      const participants: DebateMember[] = available.map((p, i) => {
        const persona = personas[i];
        return {
          label: p.label,
          provider: p.provider,
          model: p.model,
          ...(persona ? { systemPrompt: persona.systemPrompt, archetype: persona.name } : {}),
          ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}),
        };
      });

      const transport: IStreamingTransport = {
        async streamMember(member, messages, onDelta) {
          const driver = registry.get(member.provider);
          if (!driver) throw new Error(`No driver configured for provider "${member.provider}".`);
          let text = "";
          const res = await driver.stream(
            {
              model: member.model,
              messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
              maxTokens: 1_024,
              ...(member.temperature !== undefined ? { temperature: member.temperature } : {}),
            },
            (delta) => {
              if (delta.delta) {
                text += delta.delta;
                onDelta(delta.delta);
              }
            },
          );
          return {
            text,
            usage: {
              promptTokens: res.usage?.inputTokens ?? 0,
              completionTokens: res.usage?.outputTokens ?? 0,
            },
          };
        },
      };

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const outcome = await runDiscussion(
          transport,
          {
            topic: body.topic,
            participants,
            supervisor: {
              label: "Recorder",
              provider: supervisorTarget.provider,
              model: supervisorTarget.model,
            },
            settlePauseMs: clamp(body.settlePauseMs, 1_200, LIMITS.settlePauseMs),
            maxContributions: clamp(body.maxContributions, 18, LIMITS.contributions),
            maxWallMs: clamp(body.maxWallMs, 180_000, LIMITS.wallMs),
          },
          {
            onEntry: (entry) => send("entry", entry),
            onDelta: (member, text) => send("delta", { label: member.label, text }),
            onError: (member, error) =>
              send("member_error", {
                label: member.label,
                message: error instanceof Error ? error.message : String(error),
              }),
          },
        );
        send("done", outcome);
      } catch (err) {
        request.log.error(err, "discussion/stream failed");
        send("error", { message: err instanceof Error ? err.message : "Discussion failed" });
      } finally {
        reply.raw.end();
      }
      return reply;
    },
  );
}
