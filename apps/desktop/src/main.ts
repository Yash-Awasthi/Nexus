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

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} from "electron";

import { OsKeychainVault } from "./auth/keychain";
import { createSessionFile, fetchJsonHttp } from "./auth/ports";
import { createDesktopAuth, type DesktopAuth } from "./auth/session";
import { clearSignInSession, openSignInWindow } from "./auth/sign-in-window";
import {
  createInvokeHandler,
  INVOKE_CHANNEL,
  isOpenableExternally,
  isTrustedSender,
  type RunMode,
} from "./bridge";
import { startLocalApi, type LocalApi, type LocalApiPaths } from "./local-api";
import { freePort, nodeLocalApiPorts } from "./local-api-node";
import { enqueue, flush, loadQueue, saveQueue, type QueuedPrompt } from "./offline";
import { syncOnce } from "./sync";
import { fileSyncState, httpSyncTransport } from "./sync-node";
import {
  copyableApiBase,
  deepLinkFromArgs,
  PROTOCOL,
  trayMenu,
  trayTitle,
  trayTooltip,
  type TrayState,
} from "./tray";
import {
  cleanupOldUpdates,
  confirmRunningVersion,
  describeUpdate,
  fetchManifest,
  installOnQuit,
  markRolledBack,
  parseUpdateConfig,
  readPending,
  rollbackInstaller,
  stageUpdate,
  updatesDir,
  type PendingUpdate,
  type SpawnLike,
  type UpdateArch,
  type UpdateCheck,
  type UpdatePlatform,
} from "./updater";
import {
  clearWorkspace,
  describeWorkspace,
  readWorkspace,
  saveWorkspace,
  workspaceProblem,
} from "./workspace";

// Set either variable to point the window at a service that is already
// running (the dev server, or a cloud deployment). With both unset the app
// boots its own API against an embedded database — the M2 default.
const EXTERNAL_URL = process.env.NEXUS_DESKTOP_URL ?? process.env.NEXUS_API_URL;
// The deployment a local install syncs with. Unset means local-only with no
// sync at all, which is a supported way to run — not a degraded one.
const SYNC_REMOTE_URL = process.env.NEXUS_SYNC_URL;
// A signed update feed. Both values are required: without a public key a
// manifest cannot be authenticated, and an unauthenticated installer is never run.
// A packaged build reads them from `dist/update-config.json`, because a shortcut
// launch has no environment; the variables override that file for tests and dev.
function updateConfig(): { feedUrl: string; publicKey: string } {
  let shipped = { feedUrl: "", publicKey: "" };
  try {
    shipped = parseUpdateConfig(readFileSync(join(__dirname, "update-config.json"), "utf8"));
  } catch {
    // A checkout or a build made without a feed: updates stay off.
  }
  return {
    feedUrl: (process.env.NEXUS_UPDATE_FEED_URL ?? "").trim() || shipped.feedUrl,
    publicKey: (process.env.NEXUS_UPDATE_PUBLIC_KEY ?? "").trim() || shipped.publicKey,
  };
}
const UPDATE_LOG = process.env.NEXUS_UPDATE_LOG === "debug";
// A separate data directory gives a clean install beside the real one (tests, a second profile).
if (process.env.NEXUS_DESKTOP_DATA_DIR) app.setPath("userData", process.env.NEXUS_DESKTOP_DATA_DIR);
const GLASS_OPACITY = 0.86;
// Set once the user really quits; until then closing the window only hides it.
let quitting = false;
let tray: Tray | null = null;
/** The latest run-state read from the API; the tray menu and tooltip are built from it. */
let trayState: TrayState = { running: 0, failed: 0, apiBase: "", local: true };
/**
 * The offline queue lives here, not in the window: a prompt typed while the API was restarting
 * has to survive the window that typed it. The two function slots are filled once the tray
 * exists, so the bridge can flush and pick a workspace without owning either.
 */
let queuedPrompts: QueuedPrompt[] = [];
let apiOnline = true;
let flushQueuedPrompts: () => Promise<void> = async () => {};
let promptForWorkspace: () => Promise<void> = async () => {};
/** Redraw the tray from the bridge once the tray exists; a no-op before that. */
let repaintTray: () => void = () => {};
/** A deep link that arrived before the window existed (a cold start from a link). */
let pendingDeepLink: string | null = null;
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
      // The preload is bundled into one file at build time (rolldown), because
      // a sandboxed preload can require only `electron` and a few Node builtins.
      sandbox: true,
    },
  });

  // The renderer may open links, but never a second Nexus window it controls.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenableExternally(url)) void shell.openExternal(url);
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
      if (isOpenableExternally(url)) void shell.openExternal(url);
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
  // The folder chosen in the tray becomes the API's workspace. Read here, before the child
  // starts, because the variable has to be in its environment — a started process cannot be told.
  const workspaceDir = readWorkspace(dataDir) ?? undefined;
  const local = await startLocalApi(
    { ...localApiPaths(dataDir), ...(workspaceDir ? { workspaceDir } : {}) },
    nodeLocalApiPorts(dataDir, await freePort()),
  );
  return { url: local.url, mode: "local-only", local };
}

/**
 * The API entry and UI this build serves. A packaged app carries both under its
 * resources (`scripts/build-desktop-api.mjs`); a checkout runs them in place.
 */
function localApiPaths(dataDir: string): LocalApiPaths {
  const resources = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "resources");
  const entry = join(resources, "api", "index.js");
  const spaDir = join(resources, "ui");
  if (existsSync(entry) && existsSync(spaDir)) {
    return { entry, spaDir, dataDir, migrationsDir: join(resources, "api", "migrations") };
  }
  return {
    entry: join(__dirname, "..", "..", "api", "src", "index.ts"),
    spaDir: join(__dirname, "..", "..", "ui", "build", "client"),
    dataDir,
  };
}

// A second launch shows the running app rather than starting a second API on the same data.
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

/**
 * Deep links: `nexus://session/<id>` opens that conversation.
 *
 * The link is parsed once by `deepLinkTarget` and turned into a path; nothing here loads a URL
 * that came from outside. On Windows and Linux the link arrives in argv (both on a cold start and
 * on a second launch), on macOS in `open-url`.
 */
let navigateRoute: ((path: string) => void) | null = null;
function handleDeepLink(link: string): void {
  const target = deepLinkFromArgs([link]);
  if (!target) return;
  if (navigateRoute) navigateRoute(target);
  else pendingDeepLink = target;
}

if (!SMOKE) {
  // Idempotent: registering on every launch also repairs a broken association.
  app.setAsDefaultProtocolClient(PROTOCOL);
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  // A cold start from a link: the OS put it in argv before any window existed.
  const fromArgv = deepLinkFromArgs(process.argv.slice(1));
  if (fromArgv) pendingDeepLink = fromArgv;
}

app.on("before-quit", () => {
  quitting = true;
  if (SMOKE) return;
  // The marker on disk is the authority: a staged update survives a renderer
  // crash, and its hash is re-checked immediately before it runs.
  const dir = updatesDir(app.getPath("userData"));
  const pending = readPending(dir);
  if (!pending) return;
  try {
    installOnQuit({ dir, pending, spawn: spawn as unknown as SpawnLike });
    updateLog(`installing ${pending.version}`);
  } catch (installError) {
    console.error(installError);
  }
});

function platformName(): UpdatePlatform {
  return process.platform === "darwin"
    ? "darwin"
    : process.platform === "linux"
      ? "linux"
      : "win32";
}

function architectureName(): UpdateArch {
  return process.arch === "arm64" ? "arm64" : "x64";
}

/** Log a line only when the operator asked for it; never include a URL. */
function updateLog(message: string): void {
  if (UPDATE_LOG) console.log(`[update] ${message}`);
}

/**
 * One manifest fetch with a short timeout, then a background download. This is
 * deliberately not awaited before the window appears: an unreachable feed must
 * cost nothing at launch. Every failure is silent to the user and leaves no
 * pending marker, so an update that did not fully verify is never applied.
 */
async function checkForUpdates(dataDir: string): Promise<PendingUpdate | undefined> {
  const { feedUrl, publicKey } = updateConfig();
  if (!feedUrl || !publicKey) {
    updateLog("disabled: set NEXUS_UPDATE_FEED_URL and NEXUS_UPDATE_PUBLIC_KEY");
    return undefined;
  }
  if (!app.isPackaged) {
    updateLog("skipped in a checkout");
    return undefined;
  }
  const currentVersion = app.getVersion();
  const { manifest } = await fetchManifest({
    feedUrl,
    publicKey,
    fetchImpl: fetch,
  });
  // A staged rollout applies to the background check too, or the wave would only exist for
  // people who asked for it by hand — which is not a rollout.
  const check = describeUpdate({
    current: currentVersion,
    manifest,
    installId: installId(),
    configuredChannel: updateChannel(),
  });
  if (!check.eligible) {
    updateLog(check.message);
    return undefined;
  }
  const staged = await stageUpdate({
    manifest,
    currentVersion,
    platform: platformName(),
    arch: architectureName(),
    dataDir,
    fetchImpl: fetch,
  });
  if ("skipped" in staged) {
    updateLog(staged.skipped);
    return undefined;
  }
  cleanupOldUpdates(updatesDir(dataDir), staged);
  updateLog(`staged ${staged.version}; it installs on quit`);
  return staged;
}

/**
 * Which release channel this build follows. A channel is a decision the user can see, so it is
 * reported by "check now" rather than only affecting which feed is read.
 */
function updateChannel(): string {
  const fromEnv = (process.env.NEXUS_UPDATE_CHANNEL ?? "").trim();
  if (fromEnv) return fromEnv.toLowerCase();
  try {
    const shipped = JSON.parse(readFileSync(join(__dirname, "update-config.json"), "utf8")) as {
      channel?: unknown;
    };
    if (typeof shipped.channel === "string" && shipped.channel.trim())
      return shipped.channel.trim().toLowerCase();
  } catch {
    // No packaged config, or none that parses: the default channel is the honest answer.
  }
  return "stable";
}

/**
 * A stable identifier for this installation, created once.
 *
 * It exists so a staged rollout puts the same machine in the same wave every time. It is a random
 * value, not anything derived from the machine or the account: it identifies an install to a
 * rollout bucket and nothing else.
 */
function installId(): string {
  const file = join(app.getPath("userData"), "install-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
    // Not written yet.
  }
  const created = randomBytes(16).toString("hex");
  try {
    writeFileSync(file, `${created}\n`, { mode: 0o600 });
  } catch (err) {
    // A read-only data directory still gets a working check for this session.
    updateLog(`could not persist install id: ${err instanceof Error ? err.message : err}`);
  }
  return created;
}

/**
 * "Check for updates now": fetch the feed, say what it offers and on which channel, and stage it
 * when this install is in the wave. It answers even when updates are off or the feed is
 * unreachable, because "nothing happened" is the answer a person is asking about.
 */
async function checkUpdatesNow(dataDir: string): Promise<UpdateCheck> {
  const channel = updateChannel();
  const current = app.getVersion();
  const { feedUrl, publicKey } = updateConfig();
  if (!feedUrl || !publicKey) {
    return {
      current,
      channel,
      eligible: false,
      message:
        `Updates are not configured in this build (channel ${channel}, running ${current}). ` +
        "Set NEXUS_UPDATE_FEED_URL and NEXUS_UPDATE_PUBLIC_KEY, or use an installer that ships them.",
    };
  }
  try {
    const { manifest } = await fetchManifest({ feedUrl, publicKey, fetchImpl: fetch });
    const check = describeUpdate({
      current,
      manifest,
      installId: installId(),
      configuredChannel: channel,
    });
    if (check.eligible && app.isPackaged) {
      const staged = await stageUpdate({
        manifest,
        currentVersion: current,
        platform: platformName(),
        arch: architectureName(),
        dataDir,
        fetchImpl: fetch,
      });
      if (!("skipped" in staged)) cleanupOldUpdates(updatesDir(dataDir), staged);
      else updateLog(staged.skipped);
    }
    return check;
  } catch (err) {
    return {
      current,
      channel,
      eligible: false,
      message: `Could not read the update feed on channel ${channel}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * A failed boot is the rollback trigger. If the pending update names a verified
 * previous installer, restore it and restart; otherwise report the failure once.
 */
async function bootFailed(err: unknown): Promise<void> {
  console.error(err);
  const dir = updatesDir(app.getPath("userData"));
  const pending = readPending(dir);
  if (pending) {
    let restored: string | undefined;
    try {
      restored = rollbackInstaller({ dir, pending, spawn: spawn as unknown as SpawnLike });
    } catch (rollbackError) {
      console.error(rollbackError);
    }
    if (restored) {
      markRolledBack(dir, pending);
      dialog.showErrorBox(
        "Nexus could not start",
        `The update to ${pending.version} did not start. Restored ${restored}; the app will open again.`,
      );
      app.relaunch();
      app.exit(0);
      return;
    }
  }
  dialog.showErrorBox("Nexus could not start", err instanceof Error ? err.message : String(err));
  app.quit();
}

app.whenReady().then(
  async () => {
    const host = await resolveHost();
    if (host.local) app.on("will-quit", () => host.local?.stop());

    // The embedded API answered `/health/ready`, so whatever was installed last
    // is now the rollback target rather than something to undo.
    try {
      confirmRunningVersion({
        dir: updatesDir(app.getPath("userData")),
        runningVersion: app.getVersion(),
      });
    } catch (confirmError) {
      console.error(confirmError);
    }

    const win = createWindow(host.url);
    const show = () => {
      win.show();
      win.focus();
    };
    app.on("second-instance", (_event, argv) => {
      // A second launch with a link navigates; without one it just surfaces the window.
      const target = deepLinkFromArgs(argv ?? []);
      if (target) {
        show();
        navigate(target);
        return;
      }
      show();
    });

    /**
     * Send the window to a route. Reloading the URL is what the router already understands, and
     * it is the only navigation that cannot leave the app pointed at a stale document.
     */
    const navigate = (path: string) => {
      show();
      void win.loadURL(`${host.url}${path}`);
    };
    navigateRoute = navigate;
    // A link that arrived before the window existed is honoured once it does.
    if (pendingDeepLink) {
      navigate(pendingDeepLink);
      pendingDeepLink = null;
    }

    if (!SMOKE) {
      const icon = join(__dirname, "..", "..", "ui", "build", "client", "favicon.ico");
      tray = new Tray(nativeImage.createFromPath(icon));

      /**
       * Run state, read the same way any client would. `GET /workflows` is already the
       * question "what is the board doing", so the tray asks it instead of inventing a
       * second, tray-only endpoint that could disagree with the page.
       */
      const readRunState = async (): Promise<{
        running: number;
        failed: number;
        reachable: boolean;
      }> => {
        try {
          const res = await fetch(`${host.url}/api/v1/workflows`, {
            headers: auth.getSession()?.accessToken
              ? { Authorization: `Bearer ${auth.getSession()!.accessToken}` }
              : {},
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok)
            return { running: trayState.running, failed: trayState.failed, reachable: false };
          const list = (await res.json()) as { status?: string; lastError?: string }[];
          const running = list.filter((wf) => wf.status === "running").length;
          const failed = list.filter((wf) => wf.status === "error" || wf.lastError).length;
          return { running, failed, reachable: true };
        } catch {
          // An unreachable API is not "idle": keep the last known state rather than claiming
          // the machine is doing nothing.
          return { running: trayState.running, failed: trayState.failed, reachable: false };
        }
      };

      /**
       * The offline queue and the workspace, both owned by the main process because both are
       * things the renderer cannot do: a prompt has to survive the window, and a folder has to
       * reach the child process's environment.
       */
      const queueDir = app.getPath("userData");
      queuedPrompts = loadQueue(queueDir);

      /** POST one queued prompt to the conversation it was typed into. */
      const sendQueued = async (entry: QueuedPrompt) => {
        if (!entry.sessionId)
          return { ok: false, permanent: true, error: "the prompt has no conversation" };
        try {
          const res = await fetch(`${host.url}/api/v1/threads/${entry.sessionId}/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(auth.getSession()?.accessToken
                ? { Authorization: `Bearer ${auth.getSession()!.accessToken}` }
                : {}),
            },
            body: JSON.stringify({ content: entry.text }),
            signal: AbortSignal.timeout(20_000),
          });
          if (res.ok) return { ok: true };
          // 429 and 5xx are worth retrying; anything else is a refusal retrying cannot fix.
          const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
          return { ok: false, permanent, error: `${res.status}` };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      /** Send everything queued, in order, and persist whatever is left. */
      const flushQueue = async (): Promise<void> => {
        if (queuedPrompts.length === 0) return;
        const result = await flush(queuedPrompts, sendQueued);
        queuedPrompts = result.queue;
        saveQueue(queueDir, queuedPrompts);
        // A queue that emptied is not proof of a connection — the next poll asks for real. A
        // queue that did not empty is proof it did not.
        if (queuedPrompts.length > 0) apiOnline = false;
        trayState = { ...trayState, queued: queuedPrompts.length, online: apiOnline };
        paintTray();
        if (result.dropped.length)
          void dialog.showMessageBox({
            type: "warning",
            title: "Some queued prompts could not be sent",
            message: `${result.dropped.length} prompt(s) were refused and removed from the queue.`,
            detail: result.dropped.map((d) => d.reason).join("\n"),
            buttons: ["OK"],
          });
      };

      /** Ask the OS for a folder and make it the workspace. */
      const chooseWorkspace = async (): Promise<void> => {
        const picked = await dialog.showOpenDialog({
          title: "Choose the workspace folder",
          properties: ["openDirectory", "createDirectory"],
        });
        const folder = picked.filePaths[0];
        if (picked.canceled || !folder) return;
        const problem = workspaceProblem(folder);
        if (problem) {
          await dialog.showMessageBox({
            type: "error",
            title: "Not a workspace",
            message: problem,
          });
          return;
        }
        saveWorkspace(queueDir, folder);
        trayState = { ...trayState, workspace: folder };
        paintTray();
        // The API read the variable at start; saying so is kinder than showing a folder that
        // language servers are not using yet.
        await dialog.showMessageBox({
          type: "info",
          title: "Workspace set",
          message: describeWorkspace(folder),
          detail: "It applies the next time Nexus starts, when the local API is launched.",
          buttons: ["OK"],
        });
      };

      flushQueuedPrompts = flushQueue;
      promptForWorkspace = chooseWorkspace;

      /** Redraw the tray from `trayState`; called on every poll and every menu open. */
      const paintTray = () => {
        if (!tray) return;
        tray.setToolTip(trayTooltip(trayState));
        // The count next to the icon, where the OS supports it.
        if (process.platform === "darwin") tray.setTitle(trayTitle(trayState));
        const items = trayMenu(trayState, {
          copyApiBase: () => {
            clipboard.writeText(copyableApiBase(trayState.apiBase));
          },
          flushQueued: () => {
            void flushQueue();
          },
          chooseWorkspace: () => {
            void chooseWorkspace();
          },
          forgetWorkspace: () => {
            clearWorkspace(queueDir);
            trayState = { ...trayState, workspace: null };
            paintTray();
          },
        });
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: "Open Nexus", click: show },
            ...items.map((item) => ({
              label: item.label,
              enabled: item.enabled ?? true,
              click: item.click,
            })),
            { type: "separator" as const },
            {
              // "Check now" reports the channel as well as the result: a person who is told "up to
              // date" on a channel they did not expect has learned the important thing.
              label: "Check for updates now…",
              click: () => {
                void checkUpdatesNow(app.getPath("userData")).then((check) => {
                  void dialog.showMessageBox({
                    type: check.eligible ? "info" : "none",
                    title: "Nexus updates",
                    message: check.message,
                    detail: check.eligible
                      ? "The installer is downloaded and verifies before it runs; it is applied when Nexus quits."
                      : `Channel: ${check.channel}\nRunning: ${check.current}`,
                    buttons: ["OK"],
                  });
                });
              },
            },
            { label: "Quit Nexus", click: () => app.quit() },
          ]),
        );
      };

      trayState = {
        ...trayState,
        apiBase: host.url,
        local: host.local !== undefined,
        queued: queuedPrompts.length,
        online: apiOnline,
        workspace: readWorkspace(queueDir),
      };
      repaintTray = paintTray;
      tray.on("click", show);
      paintTray();

      /**
       * Poll run state. Two seconds is fast enough to be useful and slow enough that an idle
       * app is quiet; the timer is unref'd so it never keeps the process alive on its own.
       */
      const poll = setInterval(() => {
        void readRunState().then((next) => {
          const wasOnline = apiOnline;
          apiOnline = next.reachable;
          const changed =
            next.running !== trayState.running ||
            next.failed !== trayState.failed ||
            wasOnline !== apiOnline;
          if (changed) {
            trayState = {
              ...trayState,
              running: next.running,
              failed: next.failed,
              online: apiOnline,
            };
            paintTray();
          }
          // Back from a gap: send what was typed during it. This is the only place a flush is
          // started automatically, so a prompt cannot be sent twice by two wake-ups.
          if (apiOnline && !wasOnline && queuedPrompts.length > 0) void flushQueuedPrompts();
        });
      }, 2000);
      poll.unref?.();
      app.on("will-quit", () => clearInterval(poll));
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
      queuePrompt: async (input) => {
        const next = enqueue(queuedPrompts, {
          text: input.text,
          sessionId: input.sessionId ?? null,
        });
        queuedPrompts = next.queue;
        saveQueue(dataDir, queuedPrompts);
        trayState = { ...trayState, queued: queuedPrompts.length, online: apiOnline };
        repaintTray();
        if (next.dropped)
          updateLog(`offline queue full: dropped the oldest prompt (${next.dropped.id})`);
        return queuedPrompts.length;
      },
      offlineState: () => ({ online: apiOnline, queued: queuedPrompts.length }),
      flushOfflineQueue: flushQueuedPrompts,
      getWorkspace: () => readWorkspace(dataDir),
      chooseWorkspace: async () => {
        await promptForWorkspace();
        return readWorkspace(dataDir);
      },
      clearWorkspace: () => {
        clearWorkspace(dataDir);
        trayState = { ...trayState, workspace: null };
        repaintTray();
      },
    });

    ipcMain.handle(INVOKE_CHANNEL, (event, method: string, args: unknown[]) => {
      if (!isTrustedSender(event.senderFrame?.url, host.url))
        throw new Error("IPC from a page that is not Nexus");
      return handler(method, args ?? []);
    });

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

    // After the window is up: never block launch on the feed, and let it fail quietly.
    void checkForUpdates(app.getPath("userData")).catch((error: unknown) => {
      updateLog(`check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
  (error: unknown) => {
    void bootFailed(error);
  },
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
