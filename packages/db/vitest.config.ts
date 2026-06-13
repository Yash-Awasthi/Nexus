// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Scope coverage to schema files only: the DB client (src/client.ts)
      // requires a live DATABASE_URL and is not exercised by unit tests.
      // drizzle.config.ts and drizzle-schema.ts are drizzle-kit config only.
      include: ["src/schema/**/*.ts"],
      thresholds: {
        lines: 65,
        functions: 0,
        branches: 0,
        statements: 65,
      },
    },
  },
});
