// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Exclude server entry points — index.ts, ghoststack-server.ts, and
      // runtime-server.ts require live infrastructure (DB, Redis, runtime
      // process) and are covered by integration/e2e tests, not unit tests.
      exclude: ["src/index.ts", "src/ghoststack-server.ts", "src/runtime-server.ts"],
      thresholds: {
        // Thresholds calibrated to current coverage (middleware + health routes).
        // Locked at measured floor to prevent regression.
        // Raise incrementally as route unit tests are added:
        //   Phase 1 target: functions 60%, lines 40%  (add gateway + admin tests)
        //   Phase 2 target: functions 75%, lines 60%  (add council + billing tests)
        //   Phase 3 target: functions 85%, lines 80%  (full route coverage)
        lines:      30,
        functions:  36,   // measured at ~38%; -2 tolerance for fluctuation
        branches:   38,
        statements: 30,
      },
    },
  },
});
