// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Never inherit developer credentials, service URLs, or existing storage. */
export function createServerEnvironment(parent) {
  const data = mkdtempSync(path.join(tmpdir(), "nexus-e2e-"));
  const system = Object.fromEntries(
    Object.entries(parent).filter(([key]) =>
      /^(path|pathext|comspec|systemroot|windir|temp|tmp)$/i.test(key),
    ),
  );
  return {
    ...system,
    NODE_ENV: "production",
    NEXUS_DESKTOP: "1", // also disables the API's checkout .env loader
    HOST: "127.0.0.1",
    PORT: "3999",
    NEXUS_API_KEY: "e2e-local-key-0123456789abcdef",
    NEXUS_JWT_SECRET: "e2e-local-jwt-secret-0123456789abcdef",
    NEXUS_SECRETS_KEY: "e2e0".repeat(16),
    NEXUS_AUDIT_KEY: "e2e0".repeat(16),
    DATABASE_URL: `pglite://${path.join(data, "pg").replace(/\\/g, "/")}`,
    NEXUS_DATA_DIR: data,
    NEXUS_DRIVE_ROOT: path.join(data, "drives"),
    NEXUS_SPA_DIR: path.join(root, "apps/ui/build/client"),
    NEXUS_ORG_APPROVAL_STALE_HOURS: "0",
    NEXUS_EMBED_PROVIDER: "fixed",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = spawn(
    process.execPath,
    [
      "--require",
      path.join(root, "scripts/e2e-offline.cjs"),
      "--import",
      "tsx/esm",
      "dist/index.js",
    ],
    {
      cwd: path.join(root, "apps/api"),
      env: createServerEnvironment(process.env),
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
