// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { createServerEnvironment } from "./e2e-server.mjs";

test("E2E API gets fresh storage and only explicitly allowed environment", () => {
  const first = createServerEnvironment({
    PATH: "test-path",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    OPENAI_API_KEY: "not-a-real-key",
    DATABASE_URL: "do-not-use",
    NODE_OPTIONS: "do-not-inherit",
  });
  const second = createServerEnvironment({});
  try {
    assert.notEqual(first.NEXUS_DATA_DIR, second.NEXUS_DATA_DIR);
    assert.match(first.DATABASE_URL, /^pglite:\/\//);
    assert.equal(first.OPENAI_API_KEY, undefined);
    assert.equal(first.NODE_OPTIONS, undefined);
    assert.equal(first.PATH, "test-path");
    assert.equal(first.PATHEXT, ".COM;.EXE;.BAT;.CMD");
    assert.equal(first.NEXUS_DESKTOP, "1");
    assert.equal(first.HOST, "127.0.0.1");
  } finally {
    rmSync(first.NEXUS_DATA_DIR, { recursive: true, force: true });
    rmSync(second.NEXUS_DATA_DIR, { recursive: true, force: true });
  }
});
