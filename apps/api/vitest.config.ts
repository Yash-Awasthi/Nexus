// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
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
        // Phase 1 achieved: gateway + admin + libertas + lib tests added.
        // Raise incrementally as route unit tests are added:
        //   Phase 2 target: functions 75%, lines 60%  (add council + billing tests)
        //   Phase 3 target: functions 85%, lines 80%  (full route coverage)
        lines: 38,
        functions: 54, // measured ~54.8%; Phase 2 target 75% (council + billing tests)
        branches: 38,
        statements: 38,
      },
    },
  },
});
