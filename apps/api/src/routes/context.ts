// SPDX-License-Identifier: Apache-2.0
/**
 * Context-pack routes
 *
 *   POST /api/v1/context-pack   — assemble and return a context pack
 *
 * The context pack assembles recent tasks, active signals, and stored
 * memories into a structured system prompt string for LLM session priming.
 *
 * Request body (all optional):
 *   {
 *     "agent_role":    string  — custom role description
 *     "memory_query":  string  — semantic recall query for memory ranking
 *     "extra_context": string  — caller-supplied extra context
 *     "max_tokens":    number  — override default token budget (default 4000)
 *   }
 *
 * Response:
 *   {
 *     "system_prompt":        string
 *     "sections":             ContextSection[]
 *     "total_token_estimate": number
 *     "assembled_at":         string (ISO 8601)
 *     "was_trimmed":          boolean
 *   }
 */

import { db } from "@nexus/db";
import { runtimeTasks, signals, memoryEntries } from "@nexus/db/schema";
import {
  assembleContextPack,
  type ContextFetchers,
  type RecentTask,
  type ActiveSignal,
  type MemoryFact,
} from "@nexus/context-pack";
import { desc, gte, or, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── DB-backed fetchers ────────────────────────────────────────────────────────

/**
 * Build ContextFetchers backed by the Drizzle DB instance.
 * Signals filter to high/critical priority within the last 48 h.
 * Memories are returned in insertion order (vector search deferred to a
 * future PR once the PgVectorStore is fully wired).
 */
function buildDbFetchers(): ContextFetchers {
  return {
    fetchRecentTasks: async (limit: number): Promise<RecentTask[]> => {
      const rows = await db
        .select({
          id: runtimeTasks.id,
          type: runtimeTasks.type,
          status: runtimeTasks.status,
          priority: runtimeTasks.priority,
          createdAt: runtimeTasks.createdAt,
          error: runtimeTasks.error,
        })
        .from(runtimeTasks)
        .orderBy(desc(runtimeTasks.createdAt))
        .limit(limit);

      return rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        error: r.error ?? null,
      }));
    },

    fetchActiveSignals: async (limit: number): Promise<ActiveSignal[]> => {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

      const rows = await db
        .select({
          id: signals.id,
          signalType: signals.signalType,
          summary: signals.summary,
          priority: signals.priority,
          createdAt: signals.createdAt,
        })
        .from(signals)
        .where(
          or(
            eq(signals.priority, "high"),
            eq(signals.priority, "critical"),
          ),
        )
        .orderBy(desc(signals.createdAt))
        .limit(limit);

      return rows
        .filter((r) => r.createdAt >= cutoff)
        .map((r) => ({
          ...r,
          priority: r.priority as ActiveSignal["priority"],
          createdAt: r.createdAt.toISOString(),
        }));
    },

    fetchMemories: async (limit: number): Promise<MemoryFact[]> => {
      // Full vector search deferred — return most recent entries for now
      const rows = await db
        .select({
          id: memoryEntries.id,
          text: memoryEntries.text,
          createdAt: memoryEntries.createdAt,
        })
        .from(memoryEntries)
        .orderBy(desc(memoryEntries.createdAt))
        .limit(limit);

      return rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.createdAt }));
    },
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function contextRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      agent_role?: string;
      memory_query?: string;
      extra_context?: string;
      max_tokens?: number;
    };
  }>("/context-pack", { preHandler: requireAuth }, async (request, reply) => {
    const { agent_role, memory_query, extra_context, max_tokens } = request.body ?? {};

    const pack = await assembleContextPack(buildDbFetchers(), {
      agentRole: agent_role,
      memoryQuery: memory_query,
      extraContext: extra_context,
      maxTokenBudget: max_tokens ?? 4000,
    });

    return reply.send({
      system_prompt: pack.systemPrompt,
      sections: pack.sections,
      total_token_estimate: pack.totalTokenEstimate,
      assembled_at: pack.assembledAt,
      was_trimmed: pack.wasTrimmed,
    });
  });
}
