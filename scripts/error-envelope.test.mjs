// SPDX-License-Identifier: Apache-2.0
/**
 * One writer per error envelope.
 *
 * The OpenAI-shaped envelopes now come from `apps/api/src/lib/reply-errors.ts`; the
 * Nexus-shaped `{ error: "code" }` ones are still written inline in 360-odd handlers,
 * because rewriting them all at once would bury this change in noise. So the rule is a
 * ratchet: the inline count may fall, never rise. A new handler that copies a neighbour
 * instead of calling `fail()` fails here.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const API_SRC = fileURLToPath(new URL("../apps/api/src", import.meta.url));

/** Measured on 2026-11-25 after the OpenAI surfaces were moved to the helper. Lower is better. */
const BASELINE = 363;

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sources = files(API_SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("the inline Nexus envelope count never grows", () => {
  const inline = sources.flatMap((source) =>
    source.text.split("\n").filter((line) => line.includes("send({ error:")),
  );
  assert.ok(
    inline.length <= BASELINE,
    `${inline.length} inline error replies, baseline ${BASELINE} — call fail(reply, status, code) from ../lib/reply-errors.ts instead`,
  );
});

test("no route writes an OpenAI-shaped error object by hand", () => {
  const offenders = sources
    .filter((source) => !source.path.endsWith("reply-errors.ts"))
    .filter((source) =>
      /error:\s*\{\s*type:\s*"(invalid_request_error|provider_unavailable)/.test(source.text),
    )
    // The batch route forwards an upstream envelope it did not build; it is one call, and the
    // rest of that file's errors go through the helper.
    .map((source) => source.path.replace(API_SRC, "apps/api/src"));
  assert.deepEqual(offenders, [], "use openaiError()/gatewayError() from ../lib/reply-errors.ts");
});

test("both helper writers still exist and are exported", () => {
  const helper = sources.find((source) => source.path.endsWith("reply-errors.ts"));
  assert.ok(helper, "reply-errors.ts is missing");
  for (const name of ["fail", "openaiError", "gatewayError"]) {
    assert.match(helper.text, new RegExp(`export function ${name}\\(`), `${name} is not exported`);
  }
});
