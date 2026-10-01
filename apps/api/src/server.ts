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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import { getTracer, enableTracing } from "@nexus/llm-tracer";
import {
  InMemoryAnalyticsClient,
  NexusAnalytics,
  NexusEvents,
  PostHogAnalyticsClient,
} from "@nexus/posthog-analytics";
import { startTracing, stopTracing } from "@nexus/telemetry";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { maturityForPath, MATURITY_DESCRIPTION, type Maturity } from "./lib/api-maturity.js";
import { attachChannels } from "./lib/channels.js";
import { costLogStore } from "./lib/cost-log.js";
import { idle as idleOrgRuns } from "./lib/org-runtime.js";
import { initPatStore } from "./lib/pat-store.js";
import { asUser } from "./lib/provider-keys.js";
import { makeRateLimitPreHandler, makeUserRateLimitPreHandler } from "./lib/rate-limiter.js";
import { flushTraces, recordTrace, type LlmStep } from "./lib/request-traces.js";
import { sentryReporter } from "./lib/sentry-reporter.js";
import { parseTrustProxy } from "./lib/trust-proxy.js";
import { requireAuthWithTier, resolveIdentity } from "./middleware/auth.js";
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
import { channelRoutes } from "./routes/channels.js";
import { chatAnalystRoutes } from "./routes/chat-analyst.js";
import { chatSuggestionsRoutes } from "./routes/chat-suggestions.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { contextRoutes } from "./routes/context.js";
import { conversationAnalysisRoutes } from "./routes/conversation-analysis.js";
import { corpusBuilderRoutes } from "./routes/corpus-builder.js";
import { councilRoutes } from "./routes/council.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { diffRoutes } from "./routes/diff.js";
import { discussionRoutes } from "./routes/discussion.js";
import { docPipelineRoutes } from "./routes/doc-pipeline.js";
import { driveRoutes } from "./routes/drive.js";
import { execApprovalRoutes } from "./routes/exec-approvals.js";
import { featureFlagsRoutes } from "./routes/feature-flags.js";
import { forecastRoutes } from "./routes/forecast.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { geoipRoutes } from "./routes/geoip.js";
import { governanceRoutes } from "./routes/governance.js";
import { healthRoutes } from "./routes/health.js";
import { hooksRoutes } from "./routes/hooks.js";
import { i18nRoutes } from "./routes/i18n.js";
import { ingestRoutes } from "./routes/ingest.js";
import { libertasRoutes } from "./routes/libertas.js";
import { llmOauthRoutes } from "./routes/llm-oauth.js";
import { llmRoutes } from "./routes/llm.js";
import { localPtyRoutes } from "./routes/local-pty.js";
import { mailIngestRoutes } from "./routes/mail-ingest.js";
import { mcpOpenApiRoutes } from "./routes/mcp-openapi.js";
import { mcpServersRoutes } from "./routes/mcp-servers.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { metricsRoutes } from "./routes/metrics.js";
import { mfaRoutes } from "./routes/mfa.js";
import { missionRoutes } from "./routes/missions.js";
import { nlpRoutes } from "./routes/nlp.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { oauthRoutes } from "./routes/oauth.js";
import { oidcRoutes } from "./routes/oidc.js";
import { openaiBatchRoutes } from "./routes/openai-batch.js";
import { openaiRoutes } from "./routes/openai.js";
import { orgHookRoutes, orgRoutes } from "./routes/org.js";
import { pluginRegistryRoutes } from "./routes/plugin-registry.js";
import { pluginRunRoutes } from "./routes/plugin-run.js";
import { predictionMarketRoutes } from "./routes/prediction-market.js";
import { redteamRoutes } from "./routes/redteam.js";
import { researcherRoutes } from "./routes/researcher.js";
import { rlhfRoutes } from "./routes/rlhf.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { samlRoutes } from "./routes/saml.js";
import { scenarioPlannerRoutes } from "./routes/scenario-planner.js";
import { scimRoutes } from "./routes/scim.js";
import { scrapingMcpRoutes } from "./routes/scraping-mcp.js";
import { secretRoutes } from "./routes/secrets.js";
import { sessionSyncRoutes } from "./routes/session-sync.js";
import { sftRoutes } from "./routes/sft.js";
import { sseRoutes } from "./routes/sse.js";
import { stmRoutes } from "./routes/stm.js";
import { threadsRoutes } from "./routes/threads.js";
import { userDataRoutes } from "./routes/user-data.js";
import { wikiRoutes } from "./routes/wiki.js";
import { workspacesRoutes } from "./routes/workspaces.js";

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

// Augment FastifyRequest to carry optional trace span
declare module "fastify" {
  interface FastifyRequest {
    _nexusSpan?: ReturnType<ReturnType<typeof getTracer>["startSpan"]>;
    _llmSteps?: LlmStep[];
  }
}

async function traceLlmRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const steps = request._llmSteps;
  if (!steps?.length) return;
  recordTrace({
    method: request.method,
    url: request.url,
    status: reply.statusCode,
    userId: request.nexusUserId ?? null,
    latencyMs: reply.elapsedTime,
    steps,
  });
}

/** Runs the rest of a request as its caller, with the provider keys they saved. */
export function enterUserContext(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: () => void,
): void {
  request._llmSteps = [];
  void resolveIdentity(request)
    .catch(() => undefined)
    .then(() => asUser(request.nexusUserId ?? null, done, request._llmSteps));
}

/**
 * The built SPA boots from inline scripts in index.html; allow exactly those by
 * hash so the strict script policy still holds when this server serves the UI.
 */
function spaInlineScriptHashes(spaDir: string | undefined): string[] {
  if (!spaDir) return [];
  let html: string;
  try {
    html = readFileSync(join(spaDir, "index.html"), "utf8");
  } catch {
    return [];
  }
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) =>
      `'sha256-${createHash("sha256")
        .update(m[1] ?? "")
        .digest("base64")}'`,
  );
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
    // Behind a proxy every request comes from the proxy; per-IP limits need the client's address.
    trustProxy: parseTrustProxy(process.env.NEXUS_TRUST_PROXY),
    // A plugin's first DB/KV call can exceed the 10s default on a cold, low-CPU free host
    // (a fresh Postgres connection over TLS), which would abort startup. 60s absorbs that.
    pluginTimeout: Number(process.env.NEXUS_PLUGIN_TIMEOUT_MS) || 60_000,
  });

  // ── Plugins ───────────────────────────────────────────────────────────────
  // CSP: strict policy for the web app; report-only in dev (NEXUS_CSP_REPORT_ONLY=true)
  // Security note: connectSrc includes ALLOWED_ORIGINS for SSE/CORS compatibility.
  // In production, set ALLOWED_ORIGINS to the specific frontend origin (not wildcard).
  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'strict-dynamic'", ...spaInlineScriptHashes(process.env.NEXUS_SPA_DIR)],
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

  // ── OpenAPI ───────────────────────────────────────────────────────────────
  // The spec is generated from the live route table rather than maintained by
  // hand: the hand-written openapi.yaml covered 21 of ~850 registered paths and
  // was never going to catch up. Registered before the route plugins so it sees
  // every one of them. Each path carries a maturity tag (lib/api-maturity.ts)
  // so a caller can tell a durable endpoint from a synthetic one.
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Nexus API",
        // Contract version, bumped by hand. Deliberately not read from the
        // environment: the generated openapi.yaml is compared byte for byte in
        // CI, and a value that shifts with how the process was started would
        // fail that check for no reason.
        version: "0.1.0",
        description:
          "Generated from the live Fastify route table. Every path carries a maturity tag: " +
          Object.entries(MATURITY_DESCRIPTION)
            .map(([tag, text]) => `\`${tag}\` — ${text}`)
            .join(" "),
        license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
      },
      tags: (Object.keys(MATURITY_DESCRIPTION) as Maturity[]).map((name) => ({
        name,
        description: MATURITY_DESCRIPTION[name],
      })),
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: ({ schema, url }) => {
      const existing = schema?.tags ?? [];
      return { schema: { ...schema, tags: [...existing, maturityForPath(url)] }, url };
    },
  });

  // Served unauthenticated on purpose: a spec third parties build against is
  // useless behind the credential it documents.
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // ── OpenTelemetry — a server span per request, joined to the caller's trace ─
  const otel = startTracing("nexus-api");
  if (otel) {
    const spans = new WeakMap<FastifyRequest, Span>();
    app.addHook("onRequest", async (request: FastifyRequest, reply) => {
      const path = request.url.split("?")[0] ?? "";
      const span = otel.startSpan(
        `${request.method} ${request.routeOptions.url ?? path}`,
        {
          kind: SpanKind.SERVER,
          attributes: { "http.request.method": request.method, "url.path": path },
        },
        propagation.extract(context.active(), request.headers),
      );
      spans.set(request, span);
      const carrier: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), carrier);
      if (carrier["traceparent"]) reply.header("traceparent", carrier["traceparent"]);
    });
    app.addHook("onResponse", async (request: FastifyRequest, reply) => {
      const span = spans.get(request);
      if (!span) return;
      span.setAttribute("http.response.status_code", reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
  }

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
  // are tighter than metadata reads.
  const rlGroups: { prefix: string; ip: number; user: number; keyPrefix: string }[] = [
    // Pre-existing groups (limits unchanged).
    { prefix: "/api/v1/admin", ip: 30, user: 50, keyPrefix: "admin" },
    { prefix: "/api/v1/billing", ip: 20, user: 100, keyPrefix: "billing" },
    { prefix: "/api/v1/council", ip: 30, user: 60, keyPrefix: "council" },
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
    // Last, so it only catches what no group above names, the gateway included.
    { prefix: "/api/v1/", ip: 300, user: 600, keyPrefix: "v1" },
  ];
  const rlHandlers = rlGroups.map((g) => ({
    prefix: g.prefix,
    ip: makeRateLimitPreHandler({ limit: g.ip, windowMs: 60_000, keyPrefix: g.keyPrefix }),
    user: makeUserRateLimitPreHandler({ limit: g.user, windowMs: 60_000, keyPrefix: g.keyPrefix }),
  }));

  // IP-keyed limiter for the authenticated /api bridge scope (defense in depth).
  const apiScopeRL = makeRateLimitPreHandler({
    limit: Number(process.env.NEXUS_API_RATE_LIMIT) || 300,
    windowMs: 60_000,
    keyPrefix: "api",
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const url = request.url;
    const group = rlHandlers.find((g) => url.startsWith(g.prefix));
    if (!group) return;
    await group.ip(request, reply);
    if (!reply.sent) await group.user(request, reply);
  });

  // ── Cost-log write-behind: flush the pending tail on graceful close ────────
  // A clean SIGTERM/SIGINT deploy drains through app.close() (index.ts
  // gracefulShutdown), so this persists the last debounce window that a plain
  // restart would lose. Bounded + best-effort inside the store — an unclean
  // kill (tsx-watch) never reaches here and stays within the documented
  // few-seconds loss.
  app.addHook("onClose", async () => {
    // Runs that outlast the wait are failed by the boot sweep on the next start.
    await idleOrgRuns(5_000).catch(() => {});
    await flushTraces();
    await costLogStore.close();
    // Spans are exported in batches; the last batch goes out only on shutdown.
    await stopTracing().catch(() => {});
  });

  // ── Health (no prefix — /health, /health/ready) ───────────────────────────
  await app.register(healthRoutes);

  // ── API v1 routes ─────────────────────────────────────────────────────────
  await app.register(
    async (api) => {
      api.addHook("preHandler", enterUserContext);
      api.addHook("onResponse", traceLlmRequest);
      // Core platform
      await api.register(ingestRoutes);
      await api.register(councilRoutes);
      await api.register(discussionRoutes);
      await api.register(execApprovalRoutes);
      await api.register(secretRoutes);
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
      await api.register(corpusBuilderRoutes);
      await api.register(predictionMarketRoutes);

      // Full-feature pages
      await api.register(conversationAnalysisRoutes);
      await api.register(nlpRoutes);
      await api.register(geoipRoutes);
      await api.register(i18nRoutes);
      await api.register(mailIngestRoutes);
      await api.register(billingRoutes);
      await api.register(adminRoutes);
      await api.register(featureFlagsRoutes);
      await api.register(channelRoutes);
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
      await api.register(mcpOpenApiRoutes);

      // R — hooks registry + alert engine
      await api.register(hooksRoutes);
      await api.register(alertsRoutes);

      // S — librarian + file-explorer agents, bot webhooks
      await api.register(agentsRoutes);
      await api.register(botsRoutes);
      await api.register(chatAnalystRoutes);

      // P — rlhf, sft-tagger, llm-router, scenario-planner
      await api.register(rlhfRoutes);
      await api.register(sftRoutes);
      await api.register(pluginRegistryRoutes);
      await api.register(pluginRunRoutes);
      await api.register(llmRoutes);
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
      await api.register(userDataRoutes);
      await api.register(workspacesRoutes);
      await api.register(driveRoutes);
      await api.register(mfaRoutes);

      // AF — Libertas: public free-tier endpoint (no auth required)
      await api.register(libertasRoutes);

      // Enterprise — SCIM 2.0 provisioning + admin user management
      await api.register(scimRoutes);
      await api.register(adminUsersRoutes);
      // Scoped under /traces (playtest e2e round): adminTracesRoutes previously
      // registered its bare / and /:id handlers at the /api/v1 root, so ANY
      // unknown single-segment v1 path (e.g. /api/v1/agents) resolved to the
      // trace lookup and answered "trace_not_found" instead of a plain 404.
      await api.register(adminTracesRoutes, { prefix: "/traces" });

      // Enterprise — generic OIDC SSO (Okta, Azure AD, Keycloak, etc.)
      await api.register(oidcRoutes);

      // Enterprise — SAML 2.0 SSO (Okta, Azure AD, Google Workspace, etc.)
      await api.register(samlRoutes);

      // System diagnostics — consolidated operability endpoint
      await api.register(diagnosticsRoutes);

      // Org routine webhooks: unauthenticated, verified by per-routine HMAC.
      await api.register(orgHookRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ── API-bridge routes (/api/* — no version prefix) ─────────────────────
  // Bridges legacy frontend call surface to the Nexus backend.
  // Auth-gated: every /api/* route now requires a valid Bearer token.
  // (Individual route-level auth in api-bridge.ts is retained for double-check.)
  await app.register(
    async (scoped) => {
      // requireAuthWithTier validates identically to requireAuth AND resolves
      // request.nexusUserId — every /api route gets its caller identity (the
      // LLM response cache keys on it for per-user isolation).
      scoped.addHook("preHandler", requireAuthWithTier);
      scoped.addHook("preHandler", apiScopeRL);
      scoped.addHook("preHandler", enterUserContext);
      scoped.addHook("onResponse", traceLlmRequest);
      await scoped.register(apiBridgeRoutes);
      await scoped.register(notificationsRoutes);
      await scoped.register(threadsRoutes);
      await scoped.register(diffRoutes);
      await scoped.register(missionRoutes);
      await scoped.register(orgRoutes);
      // Local PTY terminal plane (localhost-only, spawns real processes).
      await scoped.register(localPtyRoutes);
    },
    { prefix: "/api" },
  );

  // ── OpenAI-compatible API (/v1/*): an OpenAI client's base URL points here ──
  await app.register(
    async (v1) => {
      v1.addHook("preHandler", requireAuthWithTier);
      v1.addHook("preHandler", apiScopeRL);
      v1.addHook("preHandler", enterUserContext);
      v1.addHook("onResponse", traceLlmRequest);
      await v1.register(openaiRoutes);
      await v1.register(openaiBatchRoutes);
    },
    { prefix: "/v1" },
  );

  // ── PAT hydration (playtest round 5) ─────────────────────────────────────
  // Rebuild the in-memory PAT cache from the api_keys table (source of truth)
  // so tokens survive restarts. No-op in tests / without a reachable DB.
  await initPatStore();

  // ── Built SPA (desktop / single-origin deploys) ───────────────────────────
  // NEXUS_SPA_DIR points at apps/ui's build output. Serving it from the API
  // is what lets the desktop app run on one origin, so the UI's /api/* calls
  // are same-origin exactly as they are in a browser. Unset in cloud
  // deployments, where a CDN serves the SPA and this block never registers.
  const spaDir = process.env.NEXUS_SPA_DIR;
  if (spaDir) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: spaDir, wildcard: false });
    // Other sites' pages load the embeddable widget; every other file stays same-origin.
    app.addHook("onSend", async (request, reply) => {
      if (request.url.split("?")[0] === "/widget.js")
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    });
    // Client-side routing: any non-/api path that matched no file is the SPA
    // shell, not a 404. API paths keep answering 404 as JSON — a deep link
    // typo must not look like a working endpoint returning HTML.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || /^\/(api|v1)(\/|\?|$)/.test(request.url)) {
        return reply.code(404).send({ error: "Not Found", statusCode: 404 });
      }
      return reply.sendFile("index.html");
    });
  }

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

  attachChannels(app.server);
  return app;
}
