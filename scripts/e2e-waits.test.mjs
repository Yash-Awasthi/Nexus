// SPDX-License-Identifier: Apache-2.0
/**
 * A fixed sleep is a guess about a machine, and the guess is wrong wherever the
 * suite runs slower than the author's laptop — which is the flake everyone then
 * re-runs. The e2e specs may wait for a condition (a poll with a deadline, a
 * `waitFor()` on a locator); they may not sleep a fixed interval and hope.
 *
 * Two rules, both cheap to check mechanically:
 *
 *   1. `waitForTimeout(...)` never appears. Playwright's own docs call it a last
 *      resort for debugging, and it is the usual way a fixed sleep gets in.
 *   2. A `setTimeout` wait of 200 ms or more lives inside a polling helper whose
 *      name says so (`waitFor…`, `poll…`, `…until…`, `…settle…`). Sleeping inside
 *      a test body is what makes a spec slow *and* flaky.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const E2E_DIRS = ["apps/ui/tests/e2e", "apps/desktop/tests/e2e"];
const FIXED_SLEEP = /setTimeout\(\s*(?:r|resolve)\s*,\s*([0-9_]+)\s*\)/;
const POLLING_NAME = /^(wait|poll|until|settle)/i;

/**
 * Every fixed sleep of `threshold` ms or more, with the function it sits in.
 * `owner` is null when the sleep sits in a test body.
 */
export function sleeps(files, threshold = 200) {
  const found = [];
  for (const { file, text } of files) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const match = FIXED_SLEEP.exec(line);
      if (!match) return;
      const ms = Number(match[1].replace(/_/g, ""));
      if (ms < threshold) return;
      let owner = null;
      for (let up = index; up >= 0; up--) {
        const isTest = /^\s*(?:test|it)(?:\.\w+)?\(/.test(lines[up]);
        if (isTest) break;
        const declaration = /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\()/.exec(
          lines[up],
        );
        if (declaration) {
          owner = declaration[1] ?? declaration[2] ?? null;
          break;
        }
      }
      found.push({ file, line: index + 1, ms, owner });
    });
  }
  return found;
}

/** Files with a Playwright `waitForTimeout`, which is banned outright. */
export function waitForTimeouts(files) {
  return files.filter(({ text }) => /waitForTimeout\(/.test(text)).map(({ file }) => file);
}

/**
 * Files that wait on `networkidle`.
 *
 * A signed-in shell keeps `/api/notifications/stream` open for the life of the tab, so `networkidle` never
 * fires and every navigation waits out its timeout instead. This is the rule that would have caught the
 * craft audit burning 15 minutes on eight waits and failing without naming a page: the condition a spec
 * wants is "the route has finished asking", which is `waitForPaint` in `fixtures.ts`.
 */
export function networkIdleWaits(files) {
  return files
    .map(({ file, text }) => ({
      file,
      lines: text
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        // The comment that explains why it is banned is allowed to say the word.
        .filter(({ line }) => /networkidle/.test(line) && !/^\s*(\/\/|\*)/.test(line)),
    }))
    .filter(({ lines }) => lines.length > 0)
    .map(({ file, lines }) => `${file}:${lines[0].number}`);
}

function specFiles() {
  const files = [];
  for (const dir of E2E_DIRS) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".spec.ts")) continue;
      const file = path.join(dir, name);
      files.push({ file, text: readFileSync(file, "utf8") });
    }
  }
  return files;
}

const FILES = specFiles();

test("read the whole e2e surface, or the rules below prove nothing", () => {
  assert.ok(FILES.length >= 15, `only ${FILES.length} spec files found`);
  // The polling helpers these rules allow exist, so the exception is real.
  assert.ok(
    FILES.some(({ text }) => /(?:async\s+function|const)\s+(?:waitFor|poll)\w*/.test(text)),
    "no polling helper found in any spec",
  );
});

test("no spec calls waitForTimeout", () => {
  assert.deepEqual(waitForTimeouts(FILES), []);
});

test("no spec waits for networkidle, which a signed-in shell never reaches", () => {
  assert.deepEqual(networkIdleWaits(FILES), []);
  // And the helper that replaced it is the one the specs use.
  assert.ok(
    FILES.some(({ text }) => text.includes("waitForPaint")),
    "no spec uses waitForPaint",
  );
});

test("a fixed sleep of 200 ms or more lives in a polling helper", () => {
  const offenders = sleeps(FILES)
    .filter((sleep) => !sleep.owner || !POLLING_NAME.test(sleep.owner))
    .map(
      (sleep) =>
        `${sleep.file}:${sleep.line} sleeps ${sleep.ms}ms in ${
          sleep.owner ? `\`${sleep.owner}\`` : "a test body"
        }`,
    );
  assert.deepEqual(offenders, []);
});

test("a sleep in a test body is reported even when a lambda is declared above it", () => {
  const text = [
    'test("t", async () => {',
    '  const cid = await api.post("/org/companies", {});',
    "  for (let i = 0; i < 5; i++) {",
    "    await new Promise((r) => setTimeout(r, 2500));",
    "  }",
    "});",
    "async function waitForFiling() {",
    "  await new Promise((r) => setTimeout(r, 1000));",
    "}",
  ].join("\n");
  const found = sleeps([{ file: "synthetic.spec.ts", text }]);
  assert.equal(found.length, 2);
  assert.equal(found[0].owner, null, "a test body is not a polling helper");
  assert.equal(found[1].owner, "waitForFiling");
});
