// SPDX-License-Identifier: Apache-2.0
import { readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

// ── Auto-resolve @nexus/* workspace packages ──────────────────────────────────
// Maps "@nexus/foo" → "<root>/packages/foo/src/index.ts" for integration tests.
//
// IMPORTANT: We use an array of {find, replacement} objects with RegExp `find`
// values to ensure EXACT matching.  String-keyed aliases in Vite do prefix
// replacement, which would cause "@nexus/db" to also match "@nexus/db/schema"
// and produce an invalid resolution path.
//
// We also handle known subpath exports explicitly (e.g. @nexus/db/schema).

const packagesDir = resolve(__dirname, "packages");

interface ViteAlias {
  find: string | RegExp;
  replacement: string;
}

function buildNexusAliases(): ViteAlias[] {
  const aliases: ViteAlias[] = [];
  let pkgNames: string[] = [];
  try {
    pkgNames = readdirSync(packagesDir);
  } catch {
    return aliases;
  }

  for (const pkg of pkgNames) {
    const entry = resolve(packagesDir, pkg, "src", "index.ts");
    if (!existsSync(entry)) continue;

    // Exact match on the package root: "@nexus/foo" (not "@nexus/foo/bar")
    aliases.push({
      find: new RegExp(`^@nexus/${pkg}$`),
      replacement: entry,
    });

    // Handle subpath exports for packages that have them
    // Currently: @nexus/db/schema → packages/db/src/schema/index.ts
    const subpaths: Record<string, string> = {
      db: resolve(packagesDir, "db", "src", "schema", "index.ts"),
    };
    if (subpaths[pkg] && existsSync(subpaths[pkg])) {
      aliases.push({
        find: new RegExp(`^@nexus/${pkg}/schema$`),
        replacement: subpaths[pkg],
      });
    }
  }

  return aliases;
}

export default defineConfig({
  resolve: {
    alias: buildNexusAliases(),
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
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
      // E2E tests — require live Postgres; run in the dedicated e2e CI job
      "apps/worker/tests/e2e/**",
      // API server integration tests — require a running Fastify server + DB
      "apps/api/tests/routes/**",
      "apps/api/tests/server.test.ts",
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
        "packages/task-queue/**",
        // Telemetry bootstrap (OTel init, pino logger, SLO tracker) and LLM
        // evaluation framework require live providers; excluded from unit coverage.
        "packages/telemetry/**",
        "packages/evals/**",
        // Require a live browser / hosted CDP / network to exercise; covered at
        // integration level, not unit. Same rationale as runtime/conductor above.
        "packages/stealth-browser/**",
        "packages/video-transcript/**",
        "packages/sandbox/**",
        "packages/agent-runtime/**",
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        // Branches get 5 points of headroom: catch-block error shapes and
        // platform-specific fallbacks (Docker unavailable, pgvector < 0.4) are
        // tested at integration level, not unit level.
        branches: 85,
      },
    },
  },
});
