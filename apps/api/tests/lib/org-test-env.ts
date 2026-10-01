// SPDX-License-Identifier: Apache-2.0
/**
 * Shared setup for the org suites. Each file gets its own data directory on
 * the JSON-file backing of PersistentStore, so a re-import after
 * vi.resetModules is a real restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, vi } from "vitest";

/** Point the stores at a fresh directory for this file; `env` sets (or, with undefined, clears) more variables. */
export function useOrgDataDir(env: Record<string, string | undefined> = {}): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-org-"));
  const wanted = { DATABASE_URL: undefined, NEXUS_DATA_DIR: dataDir, ...env };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(wanted)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

/**
 * A fresh module graph, as after a restart. `extras` imports the modules a
 * suite needs beyond the core three; they register their stores on import, so
 * the load comes after them.
 */
export async function bootOrg<E extends object = object>(extras?: () => Promise<E>) {
  vi.resetModules();
  const more = ((await extras?.()) ?? {}) as E;
  const rt = await import("../../src/lib/org-runtime.js");
  const work = await import("../../src/lib/org-work.js");
  const org = await import("../../src/lib/org-store.js");
  await org.loadOrgStore();
  return { ...more, rt, work, org };
}
