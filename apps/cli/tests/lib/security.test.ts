// SPDX-License-Identifier: Apache-2.0
import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";

import { renderPosture } from "../../src/lib/security.ts";

const checks = [
  { id: "a", title: "Audit key", status: "fail" as const, detail: "unset", fix: "set it" },
  { id: "b", title: "CORS", status: "warn" as const, detail: "open", fix: "list origins" },
  { id: "c", title: "TLS", status: "pass" as const, detail: "ok", fix: "" },
];

it("shows gaps with their fixes and hides passing checks unless asked", () => {
  const out = renderPosture(checks).map((l) => stripVTControlCharacters(l));
  expect(out).toEqual([
    "✗ Audit key",
    "    unset",
    "    fix: set it",
    "! CORS",
    "    open",
    "    fix: list origins",
    "1 passed, 1 warnings, 1 failed",
  ]);
  expect(renderPosture(checks, true).map((l) => stripVTControlCharacters(l))).toContain("✓ TLS");
});
