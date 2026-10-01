// SPDX-License-Identifier: Apache-2.0
/**
 * Drives the built desktop app (`pnpm build` first) through Playwright's Electron support.
 * Model steps run only with NEXUS_E2E_GROQ_KEY set; the key goes into the app, never a log.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 600_000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
