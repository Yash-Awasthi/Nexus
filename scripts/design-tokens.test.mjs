// SPDX-License-Identifier: Apache-2.0
/**
 * The token rule, tested the way it is used: on a temporary tree, so a test can write a violating
 * file without touching the app, and against the real tree, so the ratchet is a fact rather than a
 * claim.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUDGET_FILE,
  TOKEN_FILE,
  countInlinePx,
  fileExemption,
  format,
  readBudget,
  scan,
  scanSource,
  verdict,
} from "./design-tokens.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway root with `apps/ui/app` in it. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tokens-"));
  const app = path.join(root, "apps", "ui", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(app, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

test("catches every spelling of a colour and every literal size", () => {
  const found = scanSource(
    "x.tsx",
    [
      'const a = "#3b82f6";',
      'const b = "#abc";',
      "const c = rgba(0,0,0,0.5);",
      "const d = hsl(210 50% 40%);",
      "const e = oklch(0.6 0.1 260);",
      'const f = "text-[10px] p-[13px]";',
    ].join("\n"),
  );
  assert.deepEqual(
    found.map((v) => v.kind),
    [
      "hex colour",
      "hex colour",
      "rgb()/rgba()",
      "hsl()/hsla()",
      "oklch()/oklab()",
      "arbitrary value",
      "arbitrary value",
    ],
  );
  assert.deepEqual(
    { line: found[0].line, column: found[0].column, text: found[0].text },
    { line: 1, column: 12, text: "#3b82f6" },
  );
});

test("does not mistake a token, an id reference or a variant selector for a literal", () => {
  const found = scanSource(
    "x.tsx",
    [
      'style={{ background: "var(--card)" }}',
      '<clipPath id="clip0"><rect fill="url(#clip0)" /></clipPath>',
      'href="#section-two"',
      '<div className="group-data-[collapsible=icon]:hidden data-[state=open]:block" />',
      "// a comment about #3b82f6 and text-[9px]",
    ].join("\n"),
  );
  assert.deepEqual(found, []);
});

test("treats a Tailwind palette colour as a literal, because it ignores the theme", () => {
  const found = scanSource("x.tsx", '<p className="text-amber-500 border-red-600" />');
  assert.deepEqual(
    found.map((v) => v.kind + " " + v.text),
    ["palette colour text-amber-500", "palette colour border-red-600"],
  );
  // The app's own semantic colours are not palette colours.
  assert.deepEqual(
    scanSource("x.tsx", '<p className="text-warning text-success text-muted" />'),
    [],
  );
});

test("counts inline px in style props, and leaves tokens out of the count", () => {
  assert.equal(countInlinePx('style={{ fontSize: 11, padding: "10px 14px" }}'), 2);
  assert.equal(countInlinePx('style={{ color: "var(--muted-foreground)" }}'), 0);
});

test("passes at the budget and fails when one more arbitrary value is added", () => {
  const root = tree({ "ok.tsx": 'const c = "var(--card)";' });
  fs.writeFileSync(
    path.join(root, BUDGET_FILE),
    JSON.stringify({ arbitraryValues: 0, inlinePx: 0 }),
  );
  assert.equal(verdict(scan(root), readBudget(root)).ok, true);

  fs.writeFileSync(path.join(root, "apps/ui/app/bad.tsx"), 'const s = "p-[13px]";');
  const result = scan(root);
  const judged = verdict(result, readBudget(root));
  assert.equal(judged.ok, false);
  assert.match(judged.over[0], /arbitrary values: 1 > budget 0/);
  assert.match(format(result, readBudget(root)), /TOKEN CHECK FAIL/);
});

test("never lets a colour literal hide inside the budget", () => {
  const root = tree({ "bad.tsx": 'const c = "#fff";' });
  fs.writeFileSync(
    path.join(root, BUDGET_FILE),
    JSON.stringify({ arbitraryValues: 99, inlinePx: 99 }),
  );
  const judged = verdict(scan(root), readBudget(root));
  assert.equal(judged.ok, false);
  assert.equal(judged.colours, 1);
});

test("skips the token file, which is where literals belong", () => {
  const root = tree({ [path.basename(TOKEN_FILE)]: ":root { --primary: oklch(0.5 0.2 268); }" });
  const judged = verdict(scan(root), readBudget(root));
  assert.equal(judged.ok, true);
  assert.equal(judged.colours, 0);
});

test("reads the exemption reason from the header, and only from the header", () => {
  assert.equal(fileExemption("// design-tokens-allow-file: brand mark\ncode\n"), "brand mark");
  const buried = `${"\n".repeat(30)}// design-tokens-allow-file: too late\n`;
  assert.equal(fileExemption(buried), null);
});

test("exempts a declared file and prints why, so the exemption is not a secret", () => {
  const root = tree({
    "brand.tsx": "// design-tokens-allow-file: brand mark\nconst c = '#4285F4';\n",
  });
  const result = scan(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.exemptions, [{ file: "apps/ui/app/brand.tsx", reason: "brand mark" }]);
  assert.match(format(result, readBudget(root)), /brand\.tsx — brand mark/);
});

test("this repository has no colour literal outside the token file", () => {
  const colours = scan(REPO).violations.filter((v) => v.kind !== "arbitrary value");
  assert.deepEqual(colours, []);
});

test("this repository is inside its written-down budget, and the budget explains itself", () => {
  const budget = readBudget(REPO);
  const judged = verdict(scan(REPO), budget);
  assert.equal(judged.ok, true);
  assert.equal(judged.colours, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, BUDGET_FILE), "utf8"));
  assert.match(raw.why, /ratchet|budget/i);
});

test("keeps the type scale it declares, so the small labels are not arbitrary values", () => {
  const css = fs.readFileSync(path.join(REPO, TOKEN_FILE), "utf8");
  for (const step of ["--text-4xs", "--text-3xs", "--text-2xs"])
    assert.match(css, new RegExp(step));
});
