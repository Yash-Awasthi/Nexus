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
      // DockerReplExecutor.execute spawns real `docker` and isn't exercised by
      // unit tests; its pure isolation-policy builder (buildDockerRunArgs) and
      // resolveLimits ARE covered.
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 60,
        statements: 50,
      },
    },
  },
});
