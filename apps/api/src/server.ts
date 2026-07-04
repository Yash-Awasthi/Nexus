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

import { createRequire } from "node:module";

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

// Resolve pino-pretty to an absolute path so pino's transport worker can load it
// under pnpm's strict node_modules layout (bare "pino-pretty" fails to resolve there).
const _require = createRequire(import.meta.url);
const _prettyTarget = (() => {
  try {
    return _require.resolve("pino-pretty");
  } catch {
    return undefined;
  }
})();

import { makeRateLimitPreHandler, makeUserRateLimitPreHandler } from "./lib/rate-limiter.js";
import { sentryReporter } from "./lib/sentry-reporter.js";
import { requireAuth } from "./middleware/auth.js";
import { adminTracesRoutes } from "./routes/admin-traces.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { adminRoutes } from "./routes/admin.js";
import { agentsRoutes } from "./routes/agents.js";
import { alertsRoutes } from "./routes/alerts.js";
import { apiBridgeRoutes } from "./routes/api-bridge.js";
import { auditRoutes } from "./routes/audit.js";
import { authUsersRoutes } from "./routes/auth-users.js";
import { billingRoutes } from "./routes/billing.js";
import { botsRoutes } from "./routes/bots.js";
import { briefRoutes } from "./routes/brief.js";
import { chatAnalystRoutes } from "./routes/chat-analyst.js";
import { chatSuggestionsRoutes } from "./routes/chat-suggestions.js";
import { codeReplRoutes } from "./routes/code-repl.js";
import { conductorRoutes } from "./routes/conductor-route.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { contextRoutes } from "./routes/context.js";
import { conversationAnalysisRoutes } from "./routes/conversation-analysis.js";
import { corpusBuilderRoutes } from "./routes/corpus-builder.js";
import { councilRoutes } from "./routes/council.js";
import { docPipelineRoutes } from "./routes/doc-pipeline.js";
import { domainFeedsRoutes } from "./routes/domain-feeds.js";
import { driftRoutes } from "./routes/drift.js";
import { driveRoutes } from "./routes/drive.js";
import { evalsRoutes } from "./routes/evals.js";
import { featureFlagsRoutes } from "./routes/feature-flags.js";
import { forecastRoutes } from "./routes/forecast.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { geoipRoutes } from "./routes/geoip.js";
import { governanceRoutes } from "./routes/governance.js";
import { healthRoutes } from "./routes/health.js";
import { hooksRoutes } from "./routes/hooks.js";
import { i18nRoutes } from "./routes/i18n.js";
import { imageGenRoutes } from "./routes/image-gen.js";
import { ingestRoutes } from "./routes/ingest.js";
import { knowledgeGraphRoutes } from "./routes/knowledge-graph.js";
import { libertasRoutes } from "./routes/libertas.js";
import { llmOauthRoutes } from "./routes/llm-oauth.js";
import { llmRoutes } from "./routes/llm.js";
import { mailIngestRoutes } from "./routes/mail-ingest.js";
import { mcpServersRoutes } from "./routes/mcp-servers.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { metricsRoutes } from "./routes/metrics.js";
import { mfaRoutes } from "./routes/mfa.js";
import { nlpRoutes } from "./routes/nlp.js";
import { oauthRoutes } from "./routes/oauth.js";
import { obsProvidersRoutes } from "./routes/obs-providers.js";
import { oidcRoutes } from "./routes/oidc.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { predictionMarketRoutes } from "./routes/prediction-market.js";
import { redteamRoutes } from "./routes/redteam.js";
import { researcherRoutes } from "./routes/researcher.js";
import { rlhfRoutes } from "./routes/rlhf.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { samlRoutes } from "./routes/saml.js";
import { scenarioPlannerRoutes } from "./routes/scenario-planner.js";
import { scimRoutes } from "./routes/scim.js";
import { scrapingMcpRoutes } from "./routes/scraping-mcp.js";
import { sessionSyncRoutes } from "./routes/session-sync.js";
import { sftRoutes } from "./routes/sft.js";
import { sseRoutes } from "./routes/sse.js";
import { stmRoutes } from "./routes/stm.js";
import { videoTranscriptRoutes } from "./routes/video-transcript.js";
import { voiceRoutes } from "./routes/voice.js";
import { wikiRoutes } from "./routes/wiki.js";
import { workspacesRoutes } from "./routes/workspaces.js";

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
        process.env.NODE_ENV === "development" && _prettyTarget
          ? { target: _prettyTarget, options: { colorize: true } }
          : undefined,
    },
    // Unique request ID on every incoming request — propagated through Pino logs.
    // Format: nexus-<timestamp-hex>-<random-6>
    genReqId: () => `nexus-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`,
  });

  // ── Plugins ───────────────────────────────────────────────────────────────
  // CSP: strict policy for the web app; report-only in dev (NEXUS_CSP_REPORT_ONLY=true)
  // Security note: connectSrc includes ALLOWED_ORIGINS for SSE/CORS compatibility.
  // In production, set ALLOWED_ORIGINS to the specific frontend origin (not wildcard).
  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'strict-dynamic'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    connectSrc: ["'self'", ...(process.env.ALLOWED_ORIGINS?.split(",") ?? [])],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
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
            Record<string, unknown> | undefined
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

  // ── Defense in depth: IP + per-user rate limiting on high-value route groups ──
  // Each authenticated /api/v1 group below gets an IP-keyed limiter (throttles a
  // shared-NAT/abusive source) layered with a per-identity limiter (buckets by
  // nexusUserId or the SHA-256'd Bearer when no userId resolves). First prefix
  // match wins. Limits scale with per-call cost: inference/exec/outbound groups
  // are tighter than metadata reads. `gateway` is intentionally absent — that
  // path is already spend-guarded per identity by @nexus/billing (§5).
  const rlGroups: { prefix: string; ip: number; user: number; keyPrefix: string }[] = [
    // Pre-existing groups (limits unchanged).
    { prefix: "/api/v1/admin", ip: 30, user: 50, keyPrefix: "admin" },
    { prefix: "/api/v1/billing", ip: 20, user: 100, keyPrefix: "billing" },
    // code-repl + council carry a BYOK Bearer but often no resolved nexusUserId;
    // the per-identity limiter buckets them by API key, not a shared NAT IP.
    { prefix: "/api/v1/code-repl", ip: 10, user: 20, keyPrefix: "code-repl" },
    { prefix: "/api/v1/council", ip: 30, user: 60, keyPrefix: "council" },
    { prefix: "/api/v1/orchestration", ip: 30, user: 60, keyPrefix: "orchestration" },
    // §9.3 — remaining high-value authenticated groups (exec / outbound / heavy compute).
    { prefix: "/api/v1/drive", ip: 30, user: 60, keyPrefix: "drive" },
    { prefix: "/api/v1/image-gen", ip: 20, user: 40, keyPrefix: "image-gen" },
    { prefix: "/api/v1/voice", ip: 30, user: 60, keyPrefix: "voice" },
    { prefix: "/api/v1/researcher", ip: 15, user: 30, keyPrefix: "researcher" },
    { prefix: "/api/v1/scraping", ip: 30, user: 60, keyPrefix: "scraping" },
    { prefix: "/api/v1/memory", ip: 120, user: 240, keyPrefix: "memory" },
    { prefix: "/api/v1/agents", ip: 60, user: 120, keyPrefix: "agents" },
    { prefix: "/api/v1/evals", ip: 30, user: 60, keyPrefix: "evals" },
    { prefix: "/api/v1/mcp", ip: 60, user: 120, keyPrefix: "mcp" },
  ];
  const rlHandlers = rlGroups.map((g) => ({
    prefix: g.prefix,
    ip: makeRateLimitPreHandler({ limit: g.ip, windowMs: 60_000, keyPrefix: g.keyPrefix }),
    user: makeUserRateLimitPreHandler({ limit: g.user, windowMs: 60_000, keyPrefix: g.keyPrefix }),
  }));

  // IP-keyed limiter for the authenticated /api bridge scope (defense in depth).
  const apiScopeRL = makeRateLimitPreHandler({ limit: 300, windowMs: 60_000, keyPrefix: "api" });

  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const url = request.url;
    const group = rlHandlers.find((g) => url.startsWith(g.prefix));
    if (!group) return;
    await group.ip(request, reply);
    if (!reply.sent) await group.user(request, reply);
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
      await api.register(conversationAnalysisRoutes);
      await api.register(nlpRoutes);
      await api.register(geoipRoutes);
      await api.register(i18nRoutes);
      await api.register(mailIngestRoutes);
      await api.register(imageGenRoutes);
      await api.register(voiceRoutes);
      await api.register(billingRoutes);
      await api.register(orchestrationRoutes);
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
      await api.register(mcpServersRoutes);

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

      // Z — Provider OAuth (BYO Vertex via Google) — SEPARATE from SSO above
      await api.register(llmOauthRoutes);

      // Enterprise — user auth, workspaces, MFA
      await api.register(authUsersRoutes);
      await api.register(workspacesRoutes);
      await api.register(driveRoutes);
      await api.register(mfaRoutes);

      // AF — Libertas: public free-tier endpoint (no auth required)
      await api.register(libertasRoutes);

      // Enterprise — SCIM 2.0 provisioning + admin user management
      await api.register(scimRoutes);
      await api.register(adminUsersRoutes);
      await api.register(adminTracesRoutes);

      // Enterprise — generic OIDC SSO (Okta, Azure AD, Keycloak, etc.)
      await api.register(oidcRoutes);

      // Enterprise — SAML 2.0 SSO (Okta, Azure AD, Google Workspace, etc.)
      await api.register(samlRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ── API-bridge routes (/api/* — no version prefix) ─────────────────────
  // Bridges legacy frontend call surface to the Nexus backend.
  // Auth-gated: every /api/* route now requires a valid Bearer token.
  // (Individual route-level auth in api-bridge.ts is retained for double-check.)
  await app.register(
    async (scoped) => {
      scoped.addHook("preHandler", requireAuth);
      scoped.addHook("preHandler", apiScopeRL);
      await scoped.register(apiBridgeRoutes);
      await scoped.register(videoTranscriptRoutes);
    },
    { prefix: "/api" },
  );

  // ── Conductor orchestration routes (/api/v1/gs/*) ────────────────────────
  await app.register(
    async (gsApi) => {
      await gsApi.register(conductorRoutes);
    },
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
