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
      // Property-based tests using @fast-check/vitest@^0.4.x which requires
      // vitest ^4.x — excluded until root vitest is upgraded from 2.x
      "packages/db/tests/schema.test.ts",
      "packages/governance/tests/audit-log.test.ts",
      "packages/runtime/tests/council-bridge.test.ts",
      "packages/runtime/tests/crash-recovery.test.ts",
      "packages/telemetry/tests/health-aggregator.test.ts",
      "packages/telemetry/tests/slo-tracker.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      // Thresholds intentionally omitted — coverage is tracked via Codecov.
      // Re-enable per-package thresholds once baseline is established.
      exclude: ["**/dist/**", "**/node_modules/**", "**/*.gen.ts", "**/src/index.ts"],
    },
  },
});
