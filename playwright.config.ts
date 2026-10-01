// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end checks at phone width against the desktop-mode API, which serves
 * the built UI itself. Build first (`pnpm --filter @nexus/api build` and
 * `pnpm --filter @nexus/ui build`); an API already listening on the port is
 * refused; each run starts an isolated API with fresh embedded storage.
 */
import { defineConfig, devices } from "@playwright/test";

const port = 3999;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./apps/ui/tests/e2e",
  timeout: 180_000,
  // Every spec talks to the one API; running them in parallel only adds rate limits.
  workers: 1,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 375, height: 800 },
    isMobile: true,
    hasTouch: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    // /health answers while the app still boots; ready means sign-in works.
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
