// SPDX-License-Identifier: Apache-2.0
/**
 * How much of the HTTP surface is typed by its validators, and how much by `as`.
 *
 * `apps/api/src/routes/*` is where untrusted input meets the domain, so it is where
 * `as SomeShape` is most tempting and most likely to be wrong: a cast is a claim about a
 * request body that nothing checked. The plan asked for a count before and after; this is
 * the count, kept honest by a ratchet so the number cannot quietly grow back.
 *
 * Two numbers matter:
 *   - `any`: zero. A single `: any` in a handler disables the check for everything it touches.
 *   - `casts`: `x as SomeShape` outside the three safe narrowings (`as const`, `as string`,
 *     `as number`) and `as Error`. Each one is a claim about a body the schema should have
 *     checked instead.
 * and one that should grow:
 *   - `schemas`: handlers that declare a Fastify `schema` for body/params/query. A handler
 *     with a schema is validated before it runs; one without trusts its caller.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROUTES = fileURLToPath(new URL("../apps/api/src/routes", import.meta.url));

/** Measured 2026-11-25. `any` and `casts` may fall; `schemas` may rise. */
export const BASELINE = { any: 0, casts: 118, schemas: 91 };

const SAFE_CAST = /\bas (?:const|string|number|Error|unknown)\b/;

/** Count the four numbers over every route file. Comments are stripped first. */
export function measure(dir = ROUTES) {
  const totals = { handlers: 0, schemas: 0, casts: 0, any: 0 };
  const perFile = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const text = readFileSync(join(dir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const counts = {
      handlers: (text.match(/async \(request(?:, reply)?\)/g) ?? []).length,
      schemas: (text.match(/schema: \{/g) ?? []).length,
      casts: (text.match(/\bas [A-Z][A-Za-z0-9_]*/g) ?? []).filter(
        (match) => !SAFE_CAST.test(match),
      ).length,
      any: (text.match(/:\s*any\b|\bas any\b/g) ?? []).length,
    };
    perFile.set(file, counts);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  return { totals, perFile };
}

/** Rows that break the ratchet, as `file: what (n vs baseline)` strings. */
export function violations({ totals }, baseline = BASELINE) {
  const rows = [];
  if (totals.any > baseline.any)
    rows.push(`: any ×${totals.any} (baseline ${baseline.any}) — validate the body instead`);
  if (totals.casts > baseline.casts)
    rows.push(
      `as-casts ×${totals.casts} (baseline ${baseline.casts}) — a cast is a claim nothing checked`,
    );
  if (totals.schemas < baseline.schemas)
    rows.push(
      `declared schemas ×${totals.schemas} (baseline ${baseline.schemas}) — a handler lost its validator`,
    );
  return rows;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const measured = measure();
  const rows = violations(measured);
  console.log(
    `route types: ${measured.totals.handlers} handlers, ${measured.totals.schemas} declared schemas, ` +
      `${measured.totals.casts} as-casts, ${measured.totals.any} any`,
  );
  for (const row of rows) console.error(`✖ ${row}`);
  process.exit(rows.length === 0 ? 0 : 1);
}
