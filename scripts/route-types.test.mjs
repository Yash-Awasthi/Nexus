// SPDX-License-Identifier: Apache-2.0
/**
 * A ratchet is only a ratchet if it moves both ways: the count may fall, not rise, and a
 * handler that loses its validator must not slip through because the total stayed level.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { BASELINE, measure, violations } from "./route-types.mjs";

const scratch = mkdtempSync(join(tmpdir(), "route-types-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Write one route file into a throwaway directory and measure it. */
function withRoutes(name, source) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), source);
  return measure(dir);
}

test("the real tree is at or better than the baseline", () => {
  assert.deepEqual(violations(measure()), []);
});

test("a new `: any` fails, and says to validate instead", () => {
  const measured = withRoutes(
    "any",
    "export const r = async (request) => { const body: any = request.body; return body; };",
  );
  assert.equal(measured.totals.any, 1);
  const rows = violations(measured, { any: 0, casts: 0, schemas: 0 }).join("\n");
  assert.match(rows, /: any ×1 \(baseline 0\) — validate the body instead/);
});

test("a new cast fails: a cast is a claim nothing checked", () => {
  const measured = withRoutes(
    "cast",
    "export const r = async (request) => (request.body as ChargeRequest).amount;",
  );
  assert.equal(measured.totals.casts, 1);
  const rows = violations(measured, { any: 0, casts: 0, schemas: 0 }).join("\n");
  assert.match(rows, /as-casts ×1 .*a cast is a claim/);
});

test("safe narrowings are not casts", () => {
  const measured = withRoutes(
    "safe",
    "export const r = (x: unknown) => [x as string, x as const, x as unknown];",
  );
  assert.equal(measured.totals.casts, 0, "`as string` / `as const` / `as unknown` are narrowings");
});

test("a handler that loses its schema fails even when the totals look fine", () => {
  const measured = {
    totals: { ...BASELINE, handlers: 10, schemas: BASELINE.schemas - 1 },
    perFile: new Map(),
  };
  assert.match(violations(measured).join("\n"), /a handler lost its validator/);
});

test("one more schema and one fewer cast is the direction the baseline moves", () => {
  const measured = {
    totals: {
      ...BASELINE,
      handlers: BASELINE.handlers ?? 0,
      schemas: BASELINE.schemas + 1,
      casts: BASELINE.casts - 1,
    },
    perFile: new Map(),
  };
  assert.deepEqual(violations(measured), []);
});

test("comments do not count as casts or as `any`", () => {
  const measured = withRoutes(
    "comments",
    "// Body: { input?: any } passed to (request.body as SomeShape)\n/* as Other */\nexport const x = 1;",
  );
  assert.deepEqual(measured.totals, { handlers: 0, schemas: 0, casts: 0, any: 0 });
});
