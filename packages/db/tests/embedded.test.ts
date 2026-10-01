// SPDX-License-Identifier: Apache-2.0
/** The embedded database opens under a directory whose parents do not exist yet. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, expect, it } from "vitest";

import { closeEmbeddedDb, getEmbeddedDb } from "../src/embedded.js";

const root = mkdtempSync(path.join(tmpdir(), "nexus-embedded-"));
const url = `pglite://${path.join(root, "gone", "pg").replace(/\\/g, "/")}`;

afterAll(async () => {
  await closeEmbeddedDb(url);
  rmSync(root, { recursive: true, force: true });
});

it("creates the missing parent directories", async () => {
  const { rows } = await getEmbeddedDb(url).query("SELECT 1 AS one");
  expect(rows).toEqual([{ one: 1 }]);
}, 60_000);
