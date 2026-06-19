// SPDX-License-Identifier: Apache-2.0
/** Re-exports for Docker CMD and legacy imports */
export { createConductorServer, startHttpServer } from "./conductor-server";

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startHttpServer } = require("./conductor-server");
  startHttpServer().catch((err: Error) => {
    console.error("[CRITICAL] Conductor server failed to start:", err);
    process.exit(1);
  });
}
