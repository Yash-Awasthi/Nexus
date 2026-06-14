// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Point at the flat schema bundle instead of the individual schema files.
  // drizzle-kit's internal TypeScript loader cannot resolve ".js"-suffixed
  // cross-imports (e.g. verdicts.ts → "./signals.js") because its CJS layer
  // maps ".js" to ".js", not to the ".ts" source.  The flat bundle defines
  // every table in FK-dependency order with no local imports.
  //
  // The file lives at the package root (not in src/) so vitest's coverage
  // scanner does not include it in the @nexus/db coverage report.
  schema: "./drizzle-schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
  // Migration table name — isolated from other Drizzle users on the same DB
  migrations: {
    table: "nexus_drizzle_migrations",
    schema: "public",
  },
  verbose: true,
  strict: true,
});
