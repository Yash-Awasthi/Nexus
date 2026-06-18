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
import { getTracer, enableTracing } from "@nexus/llm-tracer";
import {
  InMemoryAnalyticsClient,
  NexusAnalytics,
  NexusEvents,
  PostHogAnalyticsClient,
} from "@nexus/posthog-analytics";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";

import { makeRateLimitPreHandler } from "./lib/rate-limiter.js";
import { sentryReporter } from "./lib/sentry-reporter.js";
import { adminRoutes } from "./routes/admin.js";
import { agentsRoutes } from "./routes/agents.js";
import { alertsRoutes } from "./routes/alerts.js";
import { auditRoutes } from "./routes/audit.js";
import { driftRoutes } from "./routes/drift.js";
import { billingRoutes } from "./routes/billing.js";
import { botsRoutes } from "./routes/bots.js";
import { briefRoutes } from "./routes/brief.js";
import { chatAnalystRoutes } from "./routes/chat-analyst.js";
import { chatSuggestionsRoutes } from "./routes/chat-suggestions.js";
import { codeReplRoutes } from "./routes/code-repl.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { contextRoutes } from "./routes/context.js";
import { corpusBuilderRoutes } from "./routes/corpus-builder.js";
import { councilRoutes } from "./routes/council.js";
import { docPipelineRoutes } from "./routes/doc-pipeline.js";
import { domainFeedsRoutes } from "./routes/domain-feeds.js";
import { evalsRoutes } from "./routes/evals.js";
import { featureFlagsRoutes } from "./routes/feature-flags.js";
import { forecastRoutes } from "./routes/forecast.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { governanceRoutes } from "./routes/governance.js";
import { healthRoutes } from "./routes/health.js";
import { hooksRoutes } from "./routes/hooks.js";
import { imageGenRoutes } from "./routes/image-gen.js";
import { ingestRoutes } from "./routes/ingest.js";
import { knowledgeGraphRoutes } from "./routes/knowledge-graph.js";
import { libertasRoutes } from "./routes/libertas.js";
import { llmRoutes } from "./routes/llm.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { metricsRoutes } from "./routes/metrics.js";
import { oauthRoutes } from "./routes/oauth.js";
import { obsProvidersRoutes } from "./routes/obs-providers.js";
import { redteamRoutes } from "./routes/redteam.js";
import { predictionMarketRoutes } from "./routes/prediction-market.js";
import { researcherRoutes } from "./routes/researcher.js";
import { rlhfRoutes } from "./routes/rlhf.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { scenarioPlannerRoutes } from "./routes/scenario-planner.js";
import { scrapingMcpRoutes } from "./routes/scraping-mcp.js";
import { sessionSyncRoutes } from "./routes/session-sync.js";
import { sftRoutes } from "./routes/sft.js";
import { sseRoutes } from "./routes/sse.js";
import { stmRoutes } from "./routes/stm.js";
import { voiceRoutes } from "./routes/voice.js";
import { wikiRoutes } from "./routes/wiki.js";
import { authUsersRoutes } from "./routes/auth-users.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { mfaRoutes } from "./routes/mfa.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { apiBridgeRoutes } from "./routes/api-bridge.js";
import { conductorRoutes } from "./routes/conductor-route.js";
import { oidcRoutes } from "./routes/oidc.js";
import { scimRoutes } from "./routes/scim.js";

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
    // Unique request ID on every incoming request — propagated through Pino logs.
    // Format: nexus-<timestamp-hex>-<random-6>
    genReqId: () => `nexus-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`,
  });

  // ── Plugins ───────────────────────────────────────────────────────────────
  // CSP: strict policy for the web app; report-only in dev (NEXUS_CSP_REPORT_ONLY=true)
  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'strict-dynamic'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    connectSrc: ["'self'", ...(process.env.ALLOWED_ORIGINS?.split(",") ?? [])],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    ...(process.env.NODE_ENV === "production" ? { upgradeInsecureRequests: [] as string[] } : {}),
  };
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: cspDirectives,
      reportOnly: process.env.NEXUS_CSP_REPORT_ONLY === "true",
    },
    hsts:
      process.env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true } : false,
    frameguard: { action: "deny" },
    noSniff: true,
  });
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
    // Correlate span with Fastify's request ID for log tracing
    span.setAttributes({
      "http.method": request.method,
      "http.url": request.url,
      "nexus.req_id": request.id,
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

    // SLO tracking: record every response for availability + error rate computation
    try {
      const { sloTracker } = await import("./routes/metrics.js");
      sloTracker.record({
        success: reply.statusCode < 500,
        latencyMs: reply.elapsedTime ?? 0,
      });
    } catch {
      /* metrics not yet loaded */
    }

    // AlertEngine: fire "http.5xx" metric on every 5xx response
    if (reply.statusCode >= 500) {
      try {
        const { alertEngine } = await import("./routes/alerts.js");
        alertEngine.evaluate("http.5xx", 1).catch(() => {});
      } catch {
        /* non-fatal */
      }
    }

    // PostHog analytics — fire-and-forget on successful mutations
    if (request.method === "POST" && reply.statusCode === 201) {
      const userId =
        ((
          (request as unknown as Record<string, unknown>)["user"] as
            | Record<string, unknown>
            | undefined
        )?.["id"] as string | undefined) ?? "anonymous";
      const path = request.url.split("?")[0] ?? request.url;

      if (path.includes("/memory")) {
        analytics
          .agentTaskStarted(userId, `mem-${Date.now()}`, NexusEvents.MEMORY_STORED)
          .catch(() => {});
      } else if (path.includes("/researcher")) {
        analytics
          .agentTaskStarted(userId, `res-${Date.now()}`, NexusEvents.AGENT_TASK_STARTED)
          .catch(() => {});
      } else {
        _analyticsClient
          .track("api.mutation", userId, { path, status: reply.statusCode })
          .catch(() => {});
      }
    }
  });

  // ── IP-based rate limiting on high-value route groups ────────────────────────
  // Limits are intentionally generous to avoid blocking legitimate use.
  // Tighten per tier once tier-aware key extraction is plumbed through.
  const _adminRL = makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "admin" });
  const _billingRL = makeRateLimitPreHandler({ limit: 20, windowMs: 60_000, keyPrefix: "billing" });
  const _codeReplRL = makeRateLimitPreHandler({
    limit: 10,
    windowMs: 60_000,
    keyPrefix: "code-repl",
  });
  const _councilRL = makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "council" });

  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const url = request.url;
    if (url.startsWith("/api/v1/admin")) await _adminRL(request, reply);
    else if (url.startsWith("/api/v1/billing")) await _billingRL(request, reply);
    else if (url.startsWith("/api/v1/code-repl")) await _codeReplRL(request, reply);
    else if (url.startsWith("/api/v1/council")) await _councilRL(request, reply);
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

      // O — drift: adaptive sampling params + EMA feedback
      await api.register(driftRoutes);

      // R — hooks registry + alert engine
      await api.register(hooksRoutes);
      await api.register(alertsRoutes);

      // S — librarian + file-explorer agents, bot webhooks
      await api.register(agentsRoutes);
      await api.register(botsRoutes);
      await api.register(chatAnalystRoutes);

      // P — rlhf, sft-tagger, llm-router, evals, scenario-planner
      await api.register(rlhfRoutes);
      await api.register(sftRoutes);
      await api.register(llmRoutes);
      await api.register(evalsRoutes);
      await api.register(scenarioPlannerRoutes);

      // Y — redteam: input perturbation + Prometheus metrics
      await api.register(redteamRoutes);
      await api.register(metricsRoutes);

      // Z — OAuth SSO (Google + GitHub)
      await api.register(oauthRoutes);

      // Enterprise — user auth, workspaces, MFA
      await api.register(authUsersRoutes);
      await api.register(workspacesRoutes);
      await api.register(mfaRoutes);

      // AF — Libertas: public free-tier endpoint (no auth required)
      await api.register(libertasRoutes);

      // Enterprise — SCIM 2.0 provisioning + admin user management
      await api.register(scimRoutes);
      await api.register(adminUsersRoutes);

      // Enterprise — generic OIDC SSO (Okta, Azure AD, Keycloak, etc.)
      await api.register(oidcRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ── API-bridge routes (/api/* — no version prefix) ─────────────────────
  // Bridges legacy frontend call surface to the Nexus backend.
  // Provides: gauntlet stream, godmode stream, A/B comparison, memory,
  // knowledge-graph, settings, rooms, workflows, redteam, providers,
  // and stubs for features not yet backed by packages.
  await app.register(apiBridgeRoutes, { prefix: "/api" });

  // ── Conductor orchestration routes (/api/v1/gs/*) ────────────────────────
  await app.register(
    async (gsApi) => { await gsApi.register(conductorRoutes); },
    { prefix: "/api/v1" },
  );

  // ── Global error handler ──────────────────────────────────────────────────
  app.setErrorHandler((error: FastifyError, request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;

    // Capture unexpected 500s in Sentry (fire-and-forget)
    if (statusCode >= 500) {
      sentryReporter.captureException(error, {
        request_id: request.id,
        url: request.url,
        method: request.method,
        userId: request.nexusUserId,
      });
    }

    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
      statusCode,
    });
  });

  return app;
}
