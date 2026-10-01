// SPDX-License-Identifier: Apache-2.0
/**
 * The sign-in window: an app-owned browser window, not a headless one.
 *
 * A consent screen is something the user reads and types a password into, so it
 * has to be visible. What "app-owned" buys is that the callback never loads:
 * the navigation is cancelled the moment it starts, so the authorization code
 * is consumed by the main process rather than rendered into a page the renderer
 * could read.
 *
 * The window carries no preload and its own session partition, so a provider
 * login shares nothing with the application window.
 */

import { BrowserWindow, session as electronSession } from "electron";

import { SignInCancelledError, type OpenSignInWindow } from "./session";

const PARTITION = "persist:nexus-signin";

export const openSignInWindow: OpenSignInWindow = (authUrl, callbackPrefix) =>
  new Promise<URL>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      title: "Sign in",
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      outcome();
      if (!win.isDestroyed()) win.destroy();
    };

    const inspect = (event: { preventDefault: () => void }, url: string): void => {
      if (!url.startsWith(callbackPrefix)) return;
      // The code is single-use: letting the window load the callback would
      // spend it on a page nobody reads.
      event.preventDefault();
      finish(() => resolve(new URL(url)));
    };

    win.webContents.on("will-redirect", inspect);
    win.webContents.on("will-navigate", inspect);

    // A user who closes the window has declined. Nothing is stored, because
    // nothing was fetched.
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        reject(new SignInCancelledError());
      }
    });

    void win.loadURL(authUrl).catch((err: unknown) => finish(() => reject(err)));
  });

/** Drop every cookie the sign-in window accumulated. */
export async function clearSignInSession(): Promise<void> {
  await electronSession.fromPartition(PARTITION).clearStorageData();
}
