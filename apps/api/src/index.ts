// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — entrypoint
 */

import { buildServer } from "./server.js";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`@nexus/api listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main();
