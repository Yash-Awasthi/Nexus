// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
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
