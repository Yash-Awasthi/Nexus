// SPDX-License-Identifier: Apache-2.0
/**
 * electron-builder `afterSign` hook: notarise and staple the macOS app.
 *
 * Runs only on macOS with APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD set;
 * a local unsigned build is left alone. No secret is ever printed: the
 * credentials are read from the environment and passed as argv, which
 * notarytool consumes without writing them to a log.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { basename } = require("node:path");

exports.default = async function notarize(context) {
  if (process.platform !== "darwin") return;
  const appPath =
    context.appOutDir && `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  if (!appPath) return;
  const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD } = process.env;
  if (!APPLE_ID || !APPLE_TEAM_ID || !APPLE_APP_PASSWORD) {
    console.log("notarize: credentials absent, leaving the app unsigned");
    return;
  }
  console.log(`notarize: submitting ${basename(appPath)}`);
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      appPath,
      "--apple-id",
      APPLE_ID,
      "--team-id",
      APPLE_TEAM_ID,
      "--password",
      APPLE_APP_PASSWORD,
      "--wait",
    ],
    { stdio: "inherit" },
  );
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
};
