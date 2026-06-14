// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Large source file (3400+ lines) needs extra heap in the test workers
    poolOptions: {
      threads: {
        execArgv: ["--max-old-space-size=4096"],
      },
      forks: {
        execArgv: ["--max-old-space-size=4096"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
