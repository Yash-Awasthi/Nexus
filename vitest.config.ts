// SPDX-License-Identifier: Apache-2.0
import { resolve } from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // UI `~` alias (matches apps/ui/vite.config.ts) so apps/ui/app tests and
      // any lazy imports inside them resolve under the root vitest run.
      { find: "~", replacement: resolve(__dirname, "apps/ui/app") },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "apps/ui/app/**/*.test.ts",
    ],
    server: {
      deps: {
        // Mark native DB/Redis/crypto deps as external so Vite uses Node's
        // built-in require() for them instead of trying to bundle them.
        // These live in package-local node_modules (not hoisted to root).
        external: [/^pg$/, /^pg-pool$/, /^ioredis$/, /^@neondatabase\/serverless$/, /^drizzle-orm/],
      },
    },
    // passWithNoTests lets the root run succeed even if a glob resolves to
    // zero files (e.g. packages without a tests/ dir yet).
    passWithNoTests: true,
    exclude: [
      // Standard vitest defaults
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      // E2E tests — require live Postgres; run in the dedicated e2e CI job.
      "apps/worker/tests/e2e/**",
      // One suite, one config. These three app packages carry their own vitest
      // config — apps/api's setup file stubs pg and Redis for every file in it,
      // and running the same file under this config instead silently drops that
      // setup. Half of apps/api was excluded here for that reason and therefore
      // ran nowhere; the `app-suites` CI job now runs each package with its own
      // config. Adding a path back here would give one file two owners.
      "apps/api/tests/**",
      "apps/ui/tests/**",
      "apps/desktop/tests/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json"],
      // Scope coverage to package source only.
      // apps/api route tests and apps/worker e2e tests require a live Fastify
      // server + Postgres + Redis and run in the dedicated e2e CI job — measuring
      // them here would produce artificially low line coverage and make thresholds
      // impossible to enforce meaningfully.
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/dist/**",
        "**/node_modules/**",
        "**/*.gen.ts",
        "**/*.d.ts",
        // Barrel re-export files — no executable logic
        "**/src/index.ts",
        // Pure-type / spec packages — nothing to instrument
        "packages/contracts/**",
        "packages/shared/**",
        // Infrastructure packages — require live Docker / Redis / Postgres to
        // exercise meaningfully. Covered by the dedicated e2e CI job instead.
        "packages/conductor/**",
        "packages/runtime/**",
        // Telemetry bootstrap (OTel init, pino logger, SLO tracker) and LLM
        // evaluation framework require live providers; excluded from unit coverage.
        "packages/telemetry/**",
        "packages/evals/**",
        // Require a live browser / hosted CDP / network to exercise; covered at
        // integration level, not unit. Same rationale as runtime/conductor above.
        "packages/stealth-browser/**",
        "packages/sandbox/**",
        "packages/agent-runtime/**",
      ],
      thresholds: {
        // Re-baselined 2026-10 for Vitest 5, whose AST-aware v8 remapping
        // counts statements and branches per node rather than per line: the
        // same suite measures 85.13 statements / 87.86 lines / 88.69 functions
        // / 73.77 branches. Ratchet up as coverage improves; do not lower.
        statements: 85,
        lines: 87,
        functions: 86,
        // Branches get extra headroom: catch-block error shapes and
        // platform-specific fallbacks (Docker unavailable, pgvector < 0.4) are
        // tested at integration level, not unit level.
        branches: 73,
      },
    },
  },
});
