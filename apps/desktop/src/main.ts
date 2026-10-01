// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus desktop — Electron main process (spec milestone M1).
 *
 * Owns the window, the privileged operations behind the host bridge, and the
 * navigation rules.
 *
 * M2: with no external URL configured the app starts its own API (`local-api.ts`)
 * against an embedded database and serves the built `apps/ui` from it, so the
 * renderer's `/api/*` calls are same-origin exactly as in a browser and the
 * whole app works with no server and no network. `getRunMode` reports which of
 * the two is in effect, because an offline app that quietly answers from
 * somewhere else is worse than one that says it is offline.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from "electron";

import { OsKeychainVault } from "./auth/keychain";
import { createSessionFile, fetchJsonHttp } from "./auth/ports";
import { createDesktopAuth, type DesktopAuth } from "./auth/session";
import { clearSignInSession, openSignInWindow } from "./auth/sign-in-window";
import { createInvokeHandler, INVOKE_CHANNEL, type RunMode } from "./bridge";
import { startLocalApi, type LocalApi } from "./local-api";
import { freePort, nodeLocalApiPorts } from "./local-api-node";
import { syncOnce } from "./sync";
import { fileSyncState, httpSyncTransport } from "./sync-node";

// Set either variable to point the window at a service that is already
// running (the dev server, or a cloud deployment). With both unset the app
// boots its own API against an embedded database — the M2 default.
const EXTERNAL_URL = process.env.NEXUS_DESKTOP_URL ?? process.env.NEXUS_API_URL;
// The deployment a local install syncs with. Unset means local-only with no
// sync at all, which is a supported way to run — not a degraded one.
const SYNC_REMOTE_URL = process.env.NEXUS_SYNC_URL;
// A separate data directory gives a clean install beside the real one (tests, a second profile).
if (process.env.NEXUS_DESKTOP_DATA_DIR) app.setPath("userData", process.env.NEXUS_DESKTOP_DATA_DIR);
const GLASS_OPACITY = 0.86;
// Set once the user really quits; until then closing the window only hides it.
let quitting = false;
let tray: Tray | null = null;
/** Boot far enough to prove the window, preload and IPC wiring load, then exit. */
const SMOKE = process.env.NEXUS_DESKTOP_SMOKE === "1";

const stateFile = (): string => join(app.getPath("userData"), "window-state.json");
const councilFile = (): string => join(app.getPath("userData"), "council.json");
const sessionFile = (): string => join(app.getPath("userData"), "session.sealed");

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

function readWindowState(): WindowState {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<WindowState>;
    if (typeof saved.width === "number" && typeof saved.height === "number") {
      return saved as WindowState;
    }
  } catch {
    /* first run, or an unreadable file: fall back to the default size */
  }
  return { width: 1280, height: 860 };
}

/**
 * Signing out also drops the sign-in window's cookies. Without this the next
 * sign-in reuses the previous account's provider session and the consent screen
 * never appears, which on a shared machine signs the wrong person in.
 */
function withSignInCleanup(auth: DesktopAuth): DesktopAuth {
  return {
    ...auth,
    signOut: () => {
      auth.signOut();
      void clearSignInSession();
    },
  };
}

function createWindow(rendererUrl: string): BrowserWindow {
  const state = readWindowState();
  const win = new BrowserWindow({
    ...state,
    show: !SMOKE,
    backgroundColor: "#09090b",
    title: "Nexus",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // ponytail: the preload requires ./bridge, which a sandboxed preload
      // cannot resolve. contextIsolation plus nodeIntegration: false already
      // keep Node out of the renderer; re-enable the sandbox once the preload
      // is bundled into a single file.
      sandbox: false,
    },
  });

  // The renderer may open links, but never a second Nexus window it controls.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Anything that is not the renderer origin opens in the user's browser, so a
  // compromised page cannot navigate the privileged window somewhere else.
  const rendererOrigin = new URL(rendererUrl).origin;
  win.webContents.on("will-navigate", (event, url) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      // A target this process cannot even parse is not the renderer, and is
      // not something to hand to the user's browser either.
      event.preventDefault();
      return;
    }
    if (origin !== rendererOrigin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.on("close", (event) => {
    try {
      writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()), "utf8");
    } catch {
      /* window position is a convenience, not state worth failing on */
    }
    // Companies keep working on their schedules, so the window goes to the tray instead.
    if (tray && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  void win.loadURL(rendererUrl).catch(() => {
    void win.loadURL(
      `data:text/html,${encodeURIComponent(
        `<body style="font-family:sans-serif;background:#09090b;color:#fafafa;padding:2rem">` +
          `<h1>Nexus is not running</h1><p>Could not reach ${rendererUrl}. ` +
          `Start the app, or set NEXUS_DESKTOP_URL to where it is served.</p></body>`,
      )}`,
    );
  });

  return win;
}

/** Boot the bundled API, or adopt the one the environment points at. */
async function resolveHost(): Promise<{ url: string; mode: RunMode; local?: LocalApi }> {
  if (EXTERNAL_URL) return { url: EXTERNAL_URL, mode: "cloud" };

  const dataDir = app.getPath("userData");
  const local = await startLocalApi(
    {
      entry: join(__dirname, "..", "..", "api", "dist", "index.js"),
      spaDir: join(__dirname, "..", "..", "ui", "build", "client"),
      dataDir,
    },
    nodeLocalApiPorts(dataDir, await freePort()),
  );
  return { url: local.url, mode: "local-only", local };
}

// A second launch shows the running app rather than starting a second API on the same data.
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on("before-quit", () => {
  quitting = true;
});

app.whenReady().then(async () => {
  const host = await resolveHost();
  if (host.local) app.on("will-quit", () => host.local?.stop());

  const win = createWindow(host.url);
  const show = () => {
    win.show();
    win.focus();
  };
  app.on("second-instance", show);
  if (!SMOKE) {
    const icon = join(__dirname, "..", "..", "ui", "build", "client", "favicon.ico");
    tray = new Tray(nativeImage.createFromPath(icon));
    tray.setToolTip("Nexus");
    tray.on("click", show);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Nexus", click: show },
        { label: "Quit Nexus", click: () => app.quit() },
      ]),
    );
  }

  const dataDir = app.getPath("userData");
  const syncState = fileSyncState(dataDir);
  const auth = withSignInCleanup(
    createDesktopAuth({
      apiBase: host.url,
      http: fetchJsonHttp,
      vault: new OsKeychainVault(safeStorage),
      file: createSessionFile(sessionFile()),
      openSignIn: openSignInWindow,
    }),
  );

  /** One sync run against the cloud, using the signed-in account's token. */
  async function syncNow(sessionId: string): Promise<unknown> {
    if (!SYNC_REMOTE_URL) throw new Error("No sync target: set NEXUS_SYNC_URL.");
    const token = auth.getSession()?.accessToken;
    if (!token) throw new Error("Sign in before syncing.");
    return syncOnce(
      sessionId,
      {
        remote: httpSyncTransport(SYNC_REMOTE_URL, token),
        local: httpSyncTransport(host.url, token),
        readState: syncState.readState,
        writeState: syncState.writeState,
        now: () => new Date().toISOString(),
        deviceId: `${process.platform}-${app.getPath("userData")}`,
      },
      SYNC_REMOTE_URL,
    );
  }

  const handler = createInvokeHandler({
    runMode: () => ({ mode: host.mode, apiUrl: host.url }),
    syncNow,
    syncLedger: () => syncState.readState().ledger,
    setGlass: (on) => win.setOpacity(on ? GLASS_OPACITY : 1),
    saveCouncilMembers: (members) =>
      writeFileSync(councilFile(), JSON.stringify(members, null, 2), "utf8"),
    auth,
  });

  ipcMain.handle(INVOKE_CHANNEL, (_event, method: string, args: unknown[]) =>
    handler(method, args ?? []),
  );

  if (SMOKE) {
    win.webContents.once("did-finish-load", () => {
      void win.webContents
        .executeJavaScript("JSON.stringify(window.nexusHost?.capabilities ?? null)")
        .then((capabilities: string) => {
          console.log(`[smoke] capabilities=${capabilities}`);
          return undefined;
        })
        .finally(() => app.quit());
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(host.url);
  });
}, console.error);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
