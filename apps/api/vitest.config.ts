// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Most files here build the whole Fastify app, which takes a second or two
    // on an idle machine and several on a loaded one. Vitest's 5s default turns
    // that into a performance budget nobody meant to assert, and the failure it
    // produces names a correctness test rather than the contention that caused
    // it. These budgets bound a hang, not a slow boot.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One worker per file, and every file boots a Fastify app plus an embedded
    // Postgres: more workers than cores means the CPU is oversubscribed and the
    // boot-heavy tests miss their timeouts while the assertions are fine. Measured
    // on a 20-core machine, full suite: 20 workers → 195 s with 1–2 timeouts per
    // run; 6 workers → 227 s with none. The suite is 30 s slower and deterministic,
    // which is the trade this config exists to make.
    maxWorkers: 6,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Exclude server entry points — index.ts, conductor-server.ts, and
      // runtime-server.ts require live infrastructure (DB, Redis, runtime
      // process) and are covered by integration/e2e tests, not unit tests.
      exclude: ["src/index.ts", "src/conductor-server.ts", "src/runtime-server.ts"],
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
