#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus sandbox helper.
 *
 * Start it on the machine whose Docker should run the code, open the app, and pair
 * the browser with the code printed here. The listener is loopback-only on port
 * 4789 so the page can reach it at http://127.0.0.1:4789.
 *
 * Environment:
 *   NEXUS_SANDBOX_IMAGE   image to run (default nexus-sandbox:local)
 *   NEXUS_SANDBOX_IMAGES  comma-separated allowlist (default: the image above)
 *   NEXUS_HELPER_ORIGINS  extra page origins, comma-separated (local dev ports are built in)
 */

import { spawn } from "node:child_process";

import { createDockerRunner } from "@nexus/sandbox";

import { Pairing } from "./pairing.ts";
import { createHelperServer } from "./server.ts";

const PORT = 4789;

/** Origins the browser app is served from during development. */
const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
];

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function dockerReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info", "--format", "{{.ServerVersion}}"], {
      env: process.env,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const image = process.env["NEXUS_SANDBOX_IMAGE"] ?? "nexus-sandbox:local";
const allowedImages = list(process.env["NEXUS_SANDBOX_IMAGES"]);
const allowedOrigins = [...LOCAL_ORIGINS, ...list(process.env["NEXUS_HELPER_ORIGINS"])];

const pairing = new Pairing();
const server = createHelperServer({
  image,
  allowedImages: allowedImages.length > 0 ? allowedImages : [image],
  allowedOrigins,
  pairing,
  runner: createDockerRunner({ image }),
  dockerReady,
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use; the helper may already be running.`);
  } else {
    console.error(`Sandbox helper failed: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const { code, expiresAt } = pairing.current();
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);
  console.log(`Nexus sandbox helper: http://127.0.0.1:${PORT}`);
  console.log(`Image: ${image}`);
  console.log(`Pairing code: ${code}  (valid for ${minutes} minutes)`);
  console.log("Type the code in Nexus > Sandbox to connect this browser.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
