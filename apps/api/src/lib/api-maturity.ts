// SPDX-License-Identifier: Apache-2.0
/**
 * Maturity of an HTTP path, for the generated OpenAPI document.
 *
 * A caller reading the spec needs to know which endpoints they can build on.
 * Three answers, not two:
 *
 *   durable            — a dedicated routes/*.ts handler over real storage
 *                        (Postgres, a lib/*-store, or an external service).
 *   dedicated-volatile — a dedicated handler whose state is a process Map. It
 *                        will not throw away your request, but it will throw
 *                        away your data on the next restart.
 *   bridge             — served by routes/api-bridge.ts, the legacy in-memory
 *                        bridge. Synthetic; treat its data as demonstration.
 *
 * The plan's Stage B1 asked for two tags. The third exists because the Stage A
 * audit found handlers that had been extracted out of the bridge with
 * their process-memory stores intact (`sandbox.ts`, `connectors.ts`). Tagging those `durable` because they
 * are no longer in `api-bridge.ts` would put the same untrue claim in the spec
 * that `docs/FEATURES.md` used to make in prose.
 *
 * Classification is by path because that is all the router knows at schema
 * time. It mirrors how `server.ts` and `apiBridgeRoutes` mount each file, and
 * `tests/lib/api-maturity.test.ts` checks the two against each other.
 */

export type Maturity = "durable" | "dedicated-volatile" | "bridge";

/**
 * Surfaces mounted under the bare `/api` prefix by a dedicated `routes/*.ts`
 * file rather than by the bridge itself (the §16.7 extractions).
 */
const DEDICATED_UNDER_API: readonly string[] = [
  "/api/archetypes",
  "/api/connectors",
  "/api/costs",
  "/api/diff",
  "/api/kb",
  "/api/kg",
  "/api/marketplace",
  "/api/memory",
  "/api/missions",
  "/api/notifications",
  "/api/pty",
  "/api/research",
  "/api/sandbox",
  "/api/search",
  "/api/skills",
  "/api/stm",
  "/api/threads",
  "/api/tokens",
  "/api/workflows",
];

/**
 * Dedicated handlers whose store is a module-level Map or array. Checked before
 * `DEDICATED_UNDER_API` so the more specific answer wins.
 */
const VOLATILE: readonly string[] = ["/api/sandbox", "/api/connectors"];

function startsWithSegment(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`);
}

export function maturityForPath(url: string): Maturity {
  if (VOLATILE.some((p) => startsWithSegment(url, p))) return "dedicated-volatile";
  if (url === "/health" || startsWithSegment(url, "/health")) return "durable";
  if (startsWithSegment(url, "/api/v1")) return "durable";
  if (DEDICATED_UNDER_API.some((p) => startsWithSegment(url, p))) return "durable";
  if (startsWithSegment(url, "/api")) return "bridge";
  return "durable";
}

/** One-line explanation, attached to each path in the spec. */
export const MATURITY_DESCRIPTION: Record<Maturity, string> = {
  durable: "Dedicated handler over durable storage. Safe to build on.",
  "dedicated-volatile":
    "Dedicated handler, but its state lives in process memory and is lost on restart.",
  bridge:
    "Served by the legacy in-memory bridge (routes/api-bridge.ts). Treat its data as synthetic.",
};
