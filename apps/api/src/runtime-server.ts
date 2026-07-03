// SPDX-License-Identifier: Apache-2.0
/** Re-exports for Docker CMD and legacy imports */
import { fileURLToPath } from "node:url";

import { createConductorServer, startHttpServer } from "./conductor-server.js";

export { createConductorServer, startHttpServer };

// ESM entry-point guard — replaces the CJS `require.main === module` pattern.
// Runs only when this file is invoked directly (node runtime-server.js).
if (process.argv[1] === fileURLToPath(new URL(import.meta.url))) {
  startHttpServer().catch((err: Error) => {
    console.error("[CRITICAL] GhostStack server failed to start:", err);
    process.exit(1);
  });
}
