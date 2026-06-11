// SPDX-License-Identifier: Apache-2.0
/** Re-exports for Docker CMD and legacy imports */
export { createGhostStackServer, startHttpServer } from "./ghoststack-server.js";

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startHttpServer } = require("./ghoststack-server");
  startHttpServer().catch((err: Error) => {
    console.error("[CRITICAL] GhostStack server failed to start:", err);
    process.exit(1);
  });
}
