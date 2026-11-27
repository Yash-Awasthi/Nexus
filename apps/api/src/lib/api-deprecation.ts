// SPDX-License-Identifier: Apache-2.0
/**
 * Deprecating an API route without breaking the caller (M6.4.3).
 *
 * The promise in `docs/UPGRADING.md` is one minor of warning before a route goes away. That promise is worthless as
 * prose — it is kept by a header on the response the caller is *already* sending, which is the only place a client
 * that never reads a changelog will see it. So this module is a table plus a hook:
 *
 *   stage "deprecated" → `Deprecation: true` and `Sunset: <HTTP-date>`; the route still works
 *   stage "gone"       → the route answers 410 with the replacement named, never a silent 404
 *
 * Two rules keep the table honest, and `apps/api/tests/lib/api-deprecation.test.ts` enforces them:
 *
 *  - a `deprecated` entry's sunset is in the **future** (telling a caller a route is dying after it already died is
 *    a lie the caller cannot act on);
 *  - a `gone` entry has a replacement, because "it is gone, good luck" is how a client gets abandoned rather than
 *    migrated.
 *
 * The table is empty today. That is the correct state: nothing is deprecated until the day the first route is, and
 * an empty table with a working hook is a policy that can be applied in one line instead of one refactor.
 */

/** One route on its way out. `path` is the route template, matched with `:param` segments as wildcards. */
export interface DeprecatedRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Route template as Fastify sees it, e.g. `/api/v1/old-thing/:id`. */
  path: string;
  stage: "deprecated" | "gone";
  /** The release this was first marked in, e.g. `1.4.0`. */
  since: string;
  /** ISO date (inclusive) after which the route answers 410. */
  sunset: string;
  /** Where the caller should go instead. Required — every entry has one, by test. */
  replacement: string;
  /** Why it is going, in one sentence, for the body of the 410 and for the next reader of this table. */
  reason: string;
}

/**
 * The register. Add an entry here, then the headers and the 410 follow from the hook below — no handler changes.
 */
export const DEPRECATED_ROUTES: readonly DeprecatedRoute[] = [];

/** `true` when `path` matches `template`, treating a `:param` segment as one arbitrary segment. */
export function matchesTemplate(template: string, path: string): boolean {
  const want = template.split("/").filter(Boolean);
  const got = path.split("?")[0]!.split("/").filter(Boolean);
  if (want.length !== got.length) return false;
  return want.every((segment, index) => segment.startsWith(":") || segment === got[index]);
}

/** The first entry covering this request, or undefined. Method-insensitive entries are not a thing: be explicit. */
export function deprecationFor(
  method: string,
  path: string,
  routes: readonly DeprecatedRoute[] = DEPRECATED_ROUTES,
): DeprecatedRoute | undefined {
  return routes.find(
    (route) => route.method === method.toUpperCase() && matchesTemplate(route.path, path),
  );
}

/** `Sunset` wants an RFC 7231 HTTP-date, not an ISO string. */
export function httpDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toUTCString();
}

/** Headers for a route that still works. */
export function deprecationHeaders(route: DeprecatedRoute): Record<string, string> {
  return {
    deprecation: "true",
    sunset: httpDate(route.sunset),
    link: `<${route.replacement}>; rel="successor-version"`,
  };
}

/** The 410 body for a route past its sunset. Named replacement, never a bare 404. */
export function goneBody(route: DeprecatedRoute): {
  code: string;
  message: string;
  replacement: string;
  reason: string;
} {
  return {
    code: "ROUTE_RETIRED",
    message: `${route.method} ${route.path} was retired on ${route.sunset}. Use ${route.replacement}.`,
    replacement: route.replacement,
    reason: route.reason,
  };
}

/** True when the entry is past its sunset date, which is when a `deprecated` stage becomes `gone`. */
export function isPastSunset(route: DeprecatedRoute, now = new Date()): boolean {
  return new Date(`${route.sunset}T23:59:59Z`).getTime() < now.getTime();
}
