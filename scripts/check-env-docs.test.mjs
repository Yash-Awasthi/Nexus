// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "./check-env-docs.mjs";

function read(file = "apps/api/src/index.ts", line = 1) {
  return { first: { file, line }, files: new Set([file]), testOnly: false };
}

test("a read variable missing from .env.example fails", () => {
  const result = evaluate({
    documented: new Map(),
    reads: new Map([["NEXUS_UNLISTED", read()]]),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.counts.readUndocumented, 1);
  assert.match(result.errors.join("\n"), /NEXUS_UNLISTED .* missing from \.env\.example/);
});

test("a documented variable nothing reads fails without an allowlist entry", () => {
  const result = evaluate({
    documented: new Map([["NEXUS_DEAD", 7]]),
    reads: new Map(),
    allowlist: {},
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.counts.unreadOutsideAllowlist, 1);
  assert.match(result.errors.join("\n"), /NEXUS_DEAD .* no code reads it/);
  assert.match(result.errors.join("\n"), /scripts\/env-docs-allowlist\.mjs/);
});

test("an allowlisted unread variable passes and reports its reason", () => {
  const result = evaluate({
    documented: new Map([["NEXUS_COMPOSE_ONLY", 12]]),
    reads: new Map(),
    allowlist: { NEXUS_COMPOSE_ONLY: "compose api env; read by services/api in Python" },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.counts.unreadOutsideAllowlist, 0);
  assert.equal(result.counts.allowlistedUnread, 1);
  assert.match(result.info.join("\n"), /NEXUS_COMPOSE_ONLY .*compose api env/);
});

test("a dynamic access is informational and does not fail", () => {
  const result = evaluate({
    documented: new Map(),
    reads: new Map(),
    dynamic: [{ file: "packages/x/src/index.ts", line: 9, text: "process.env[name]" }],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.counts.dynamic, 1);
  assert.match(
    result.info.join("\n"),
    /review: dynamic env access .*packages\/x\/src\/index\.ts:9/,
  );
  assert.equal(result.errors.length, 0);
});

test("counts separate documented-read from allowlisted and undocumented reads", () => {
  const result = evaluate({
    documented: new Map([
      ["NEXUS_READ", 1],
      ["NEXUS_ALLOWED", 2],
    ]),
    reads: new Map([["NEXUS_READ", read()]]),
    allowlist: { NEXUS_ALLOWED: "read by compose" },
  });

  assert.deepEqual(result.counts, {
    documentedRead: 1,
    unreadOutsideAllowlist: 0,
    readUndocumented: 0,
    dynamic: 0,
    allowlistedUnread: 1,
    allowlistSize: 1,
  });
});
