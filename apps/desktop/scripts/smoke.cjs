// SPDX-License-Identifier: Apache-2.0
/**
 * Boot the shell far enough to prove the window, the preload and the IPC
 * wiring load, print the capability list the renderer can actually see, and
 * exit. The window never shows and no renderer server is needed: the fallback
 * page carries the same preload as the real one.
 *
 * Run with `pnpm --filter @nexus/desktop smoke` after a build.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const electron = require("electron");

const result = spawnSync(electron, [path.join(__dirname, "..", "dist", "main.js")], {
  stdio: "inherit",
  env: {
    ...process.env,
    NEXUS_DESKTOP_SMOKE: "1",
    // Port 9 is unreachable on purpose: the shell must survive a renderer that
    // is not running, and say so on screen rather than showing a blank window.
    NEXUS_DESKTOP_URL: process.env.NEXUS_DESKTOP_URL ?? "http://127.0.0.1:9",
  },
});

process.exit(result.status ?? 1);
