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
      // Exclude BullMQ/Redis process entry points — these require a live
      // Redis instance and are covered by integration tests, not unit tests.
      exclude: ["src/index.ts", "src/workers/**"],
      thresholds: {
        // Ratchet: raise by ~5 pts each sprint
        lines: 40,
        functions: 55,
        branches: 45,
        statements: 40,
      },
    },
  },
});
