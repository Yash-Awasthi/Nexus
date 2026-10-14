// SPDX-License-Identifier: Apache-2.0
/**
 * POST /api/v1/csp-report — where browsers send Content-Security-Policy violations, in the
 * legacy `report-uri` shape or the Reporting API's. Public by necessity (browsers send no
 * credentials), so the body is small, the rate is limited and only a summary is logged.
 */
import type { FastifyInstance } from "fastify";

import { makeRateLimitPreHandler } from "../lib/rate-limiter.ts";

const BODY_LIMIT = 16 * 1024;

interface CspViolation {
  document: string | null;
  directive: string | null;
  blocked: string | null;
  source: string | null;
  line: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** URLs lose their query and fragment: they can carry tokens the log must not keep. */
const bare = (v: unknown): string | null => str(v)?.replace(/[?#].*$/, "") ?? null;

function violation(r: Record<string, unknown>, legacy: boolean): CspViolation {
  const k = legacy
    ? ["document-uri", "effective-directive", "blocked-uri", "source-file", "line-number"]
    : ["documentURL", "effectiveDirective", "blockedURL", "sourceFile", "lineNumber"];
  const line = r[k[4]!];
  return {
    document: bare(r[k[0]!]),
    directive: str(r[k[1]!]) ?? str(r["violated-directive"]),
    blocked: bare(r[k[2]!]),
    source: bare(r[k[3]!]),
    line: typeof line === "number" ? line : null,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every CSP violation in a report body, whichever format the browser used. */
export function normalizeCspReports(body: unknown): CspViolation[] {
  if (isObject(body) && isObject(body["csp-report"])) return [violation(body["csp-report"], true)];
  if (!Array.isArray(body)) return [];
  return body
    .filter((r) => isObject(r) && r["type"] === "csp-violation" && isObject(r["body"]))
    .map((r) => violation((r as { body: Record<string, unknown> }).body, false));
}

const reportRateLimit = makeRateLimitPreHandler({
  limit: 60,
  windowMs: 60_000,
  keyPrefix: "csp-report",
});

export async function cspReportRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    ["application/csp-report", "application/reports+json"],
    { parseAs: "string", bodyLimit: BODY_LIMIT },
    (_req, raw, done) => {
      try {
        done(null, JSON.parse(raw as string));
      } catch {
        done(null, null);
      }
    },
  );

  app.post(
    "/csp-report",
    { bodyLimit: BODY_LIMIT, preHandler: reportRateLimit },
    async (request, reply) => {
      for (const v of normalizeCspReports(request.body))
        request.log.warn({ csp: v }, "csp violation");
      return reply.code(204).send();
    },
  );
}
