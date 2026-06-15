// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — Fastify server factory
 *
 * Creates and configures a Fastify instance with:
 *  - Helmet (security headers)
 *  - CORS
 *  - Sensible error defaults
 *  - llm-tracer onRequest hook (zero-cost when NEXUS_TRACING!=true)
 *  - All API route groups mounted under /api/v1
 */

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import {
  InMemoryAnalyticsClient,
  NexusAnalytics,
  NexusEvents,
  PostHogAnalyticsClient,
} from "@nexus/posthog-analytics";
import { getTracer, enableTracing } from "@nexus/llm-tracer";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import { adminRoutes } from "./routes/admin.js";
import { auditRoutes } from "./routes/audit.js";
import { billingRoutes } from "./routes/billing.js";
import { autotuneRoutes } from "./routes/autotune.js";
import { briefRoutes } from "./routes/brief.js";
import { evalsRoutes } from "./routes/evals.js";
import { llmRoutes } from "./routes/llm.js";
import { rlhfRoutes } from "./routes/rlhf.js";
import { scenarioPlannerRoutes } from "./routes/scenario-planner.js";
import { sftRoutes } from "./routes/sft.js";
import { docPipelineRoutes } from "./routes/doc-pipeline.js";
import { mcpRoutes } from "./routes/mcp.js";
import { scrapingMcpRoutes } from "./routes/scraping-mcp.js";
import { chatSuggestionsRoutes } from "./routes/chat-suggestions.js";
import { codeReplRoutes } from "./routes/code-repl.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { contextRoutes } from "./routes/context.js";
import { corpusBuilderRoutes } from "./routes/corpus-builder.js";
import { councilRoutes } from "./routes/council.js";
import { domainFeedsRoutes } from "./routes/domain-feeds.js";
import { featureFlagsRoutes } from "./routes/feature-flags.js";
import { forecastRoutes } from "./routes/forecast.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { governanceRoutes } from "./routes/governance.js";
import { imageGenRoutes } from "./routes/image-gen.js";
import { knowledgeGraphRoutes } from "./routes/knowledge-graph.js";
import { memoryRoutes } from "./routes/memory.js";
import { voiceRoutes } from "./routes/voice.js";
import { healthRoutes } from "./routes/health.js";
import { ingestRoutes } from "./routes/ingest.js";
import { obsProvidersRoutes } from "./routes/obs-providers.js";
import { predictionMarketRoutes } from "./routes/prediction-market.js";
import { researcherRoutes } from "./routes/researcher.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { sessionSyncRoutes } from "./routes/session-sync.js";
import { sseRoutes } from "./routes/sse.js";
import { stmRoutes } from "./routes/stm.js";
import { wikiRoutes } from "./routes/wiki.js";

// Augment FastifyRequest to carry optional trace span
declare module "fastify" {
  interface FastifyRequest {
    _nexusSpan?: ReturnType<ReturnType<typeof getTracer>["startSpan"]>;
  }
}

// ── Analytics singleton (PostHog in prod; InMemory in dev/CI) ─────────────────
const _analyticsClient = process.env.POSTHOG_API_KEY
  ? new PostHogAnalyticsClient({ apiKey: process.env.POSTHOG_API_KEY })
  : new InMemoryAnalyticsClient();

const analytics = new NexusAnalytics(_analyticsClient);

export async function buildServer(): Promise<FastifyInstance> {
  // ── Tracing (zero-cost noop when disabled) ─────────────────────────────────
  if (process.env.NEXUS_TRACING === "true") {
    enableTracing({ serviceName: "nexus-api" });
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // ── Plugins ───────────────────────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(",") ?? true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(sensible);

  // ── LLM Tracer — instruments every inbound request ───────────────────────
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const tracer = getTracer();
    if (!tracer.enabled) return;
    const name = `http.${request.method} ${request.url}`;
    const span = tracer.startSpan(name, "root");
    span.setAttributes({
      "http.method": request.method,
      "http.url": request.url,
    });
    request._nexusSpan = span;
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply) => {
    // LLM trace span
    const span = request._nexusSpan;
    if (span) {
      span.setAttribute("http.status_code", reply.statusCode);
      span.end({ status: reply.statusCode >= 500 ? "error" : "ok" });
    }

    // PostHog analytics — fire-and-forget on successful mutations
    if (request.method === "POST" && reply.statusCode === 201) {
      const userId = ((request as unknown as Record<string, unknown>)["user"] as Record<string, unknown> | undefined)?.["id"] as string | undefined ?? "anonymous";
      const path = request.url.split("?")[0] ?? request.url;

      if (path.includes("/memory")) {
        analytics.agentTaskStarted(userId, `mem-${Date.now()}`, NexusEvents.MEMORY_STORED).catch(() => {});
      } else if (path.includes("/researcher")) {
        analytics.agentTaskStarted(userId, `res-${Date.now()}`, NexusEvents.AGENT_TASK_STARTED).catch(() => {});
      } else {
        _analyticsClient.track("api.mutation", userId, { path, status: reply.statusCode }).catch(() => {});
      }
    }
  });

  // ── Health (no prefix — /health, /health/ready) ───────────────────────────
  await app.register(healthRoutes);

  // ── API v1 routes ─────────────────────────────────────────────────────────
  await app.register(
    async (api) => {
      // Core platform
      await api.register(ingestRoutes);
      await api.register(councilRoutes);
      await api.register(runtimeRoutes);
      await api.register(governanceRoutes);
      await api.register(auditRoutes);
      await api.register(gatewayRoutes);
      await api.register(sseRoutes);
      await api.register(contextRoutes);

      // Extended platform
      await api.register(stmRoutes);
      await api.register(chatSuggestionsRoutes);
      await api.register(wikiRoutes);
      await api.register(domainFeedsRoutes);
      await api.register(corpusBuilderRoutes);
      await api.register(obsProvidersRoutes);
      await api.register(predictionMarketRoutes);

      // Full-feature pages
      await api.register(knowledgeGraphRoutes);
      await api.register(imageGenRoutes);
      await api.register(voiceRoutes);
      await api.register(billingRoutes);
      await api.register(adminRoutes);
      await api.register(featureFlagsRoutes);
      await api.register(codeReplRoutes);
      await api.register(connectorsRoutes);

      // K — new backbone routes
      await api.register(memoryRoutes);
      await api.register(briefRoutes);
      await api.register(forecastRoutes);
      await api.register(sessionSyncRoutes);
      await api.register(researcherRoutes);

      // N — scraping-mcp, doc-pipeline, /mcp endpoint
      await api.register(scrapingMcpRoutes);
      await api.register(docPipelineRoutes);
      await api.register(mcpRoutes);

      // O — autotune sampling params + EMA feedback
      await api.register(autotuneRoutes);

      // P — rlhf, sft-tagger, llm-router, evals, scenario-planner
      await api.register(rlhfRoutes);
      await api.register(sftRoutes);
      await api.register(llmRoutes);
      await api.register(evalsRoutes);
      await api.register(scenarioPlannerRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ── Global error handler ──────────────────────────────────────────────────
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
      statusCode,
    });
  });

  return app;
}
