// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end checks at phone width against the desktop-mode API, which serves
 * the built UI itself. Build first (`pnpm --filter @nexus/api build` and
 * `pnpm --filter @nexus/ui build`); an API already listening on the port is
 * reused, otherwise one is started on an embedded database under the temp dir.
 */
import os from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = 3999;
const baseURL = process.env["PLAYWRIGHT_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const data = path.join(os.tmpdir(), "nexus-e2e");

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
  webServer: process.env["PLAYWRIGHT_BASE_URL"]
    ? undefined
    : {
        command: "node --import tsx/esm dist/index.js",
        cwd: "apps/api",
        // /health answers while the app still boots; ready means sign-in works.
        url: `${baseURL}/health/ready`,
        reuseExistingServer: true,
        timeout: 180_000,
        env: {
          NODE_ENV: "production",
          NEXUS_DESKTOP: "1",
          HOST: "127.0.0.1",
          PORT: String(port),
          NEXUS_API_KEY: "e2e-local-key-0123456789abcdef",
          NEXUS_JWT_SECRET: "e2e-local-jwt-secret-0123456789abcdef",
          NEXUS_SECRETS_KEY: "e2e0".repeat(16),
          DATABASE_URL: `pglite://${path.join(data, "pg").replace(/\\/g, "/")}`,
          NEXUS_DATA_DIR: path.join(data, "stores"),
          NEXUS_SPA_DIR: path.resolve("apps/ui/build/client"),
          NEXUS_ORG_APPROVAL_STALE_HOURS: "0",
        },
      },
});
