#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
/**
 * scripts/generate-clients.ts
 *
 * Thin TypeScript wrapper around the shell codegen pipeline.
 *
 * Delegates to:
 *   scripts/codegen/generate-types.sh  — TS types + Pydantic models from OpenAPI/AsyncAPI
 *
 * Usage:
 *   pnpm generate                   # full pipeline (TS + Python + AsyncAPI)
 *   pnpm generate -- --openapi-only # TS types only
 *   pnpm generate -- --python-only  # Pydantic models only
 *
 * Requires:
 *   openapi-typescript  (pnpm add -D openapi-typescript)
 *   datamodel-code-generator (pip install datamodel-code-generator)  [optional]
 *   @asyncapi/cli       (npm i -g @asyncapi/cli)                     [optional]
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ─── Validate spec files exist ────────────────────────────────────────────────

const openapiSpec = resolve(repoRoot, "packages/contracts/openapi/nexus-api.yaml");
const asyncapiSpec = resolve(repoRoot, "packages/contracts/asyncapi/nexus-events.yaml");

if (!existsSync(openapiSpec)) {
  console.error(`[generate-clients] ERROR: OpenAPI spec not found at ${openapiSpec}`);
  process.exit(1);
}

if (!existsSync(asyncapiSpec)) {
  console.warn(
    `[generate-clients] WARN: AsyncAPI spec not found at ${asyncapiSpec} — async docs will be skipped`,
  );
}

// ─── Forward CLI args to shell script ─────────────────────────────────────────

// Use spawnSync with an explicit args array (not a shell string) to prevent
// indirect command-line injection from user-supplied CLI arguments.
const scriptArgs = process.argv.slice(2);
const scriptPath = resolve(__dirname, "codegen/generate-types.sh");

console.log("[generate-clients] Starting NEXUS codegen pipeline…");
console.log(`[generate-clients] OpenAPI spec : ${openapiSpec}`);
console.log(`[generate-clients] AsyncAPI spec: ${asyncapiSpec}`);
console.log("");

const result = spawnSync("bash", [scriptPath, ...scriptArgs], {
  stdio: "inherit",
  cwd: repoRoot,
});

if (result.error) {
  console.error("[generate-clients] Failed to spawn codegen process:", result.error.message);
  process.exit(1);
}

const exitCode = result.status ?? 1;
if (exitCode !== 0) {
  console.error(`[generate-clients] Codegen failed with exit code ${exitCode}`);
  process.exit(exitCode);
}

console.log("[generate-clients] Done.");
