// SPDX-License-Identifier: Apache-2.0
/**
 * The tray's job is to answer two questions without opening the window: *is it working*, and
 * *where am I pointed*. Both are decided here as pure functions, so the answers can be tested
 * rather than observed once by hand.
 *
 * Deep links are the third piece: `nexus://session/<id>` has to survive being pasted into a
 * browser, an OS handler and a second instance's argv, and it has to refuse to become an
 * arbitrary URL load. `deepLinkTarget` is the only place that decides what a link means.
 */

/** The protocol this app registers for. A constant because it appears in three places. */
export const PROTOCOL = "nexus";

/** What the tray knows about the machine it is attached to. */
export interface TrayState {
  /** Workflows the API reports as running right now. */
  running: number;
  /** Workflows whose last run failed, so the tray can say so without a badge. */
  failed: number;
  /** The API base the window is pointed at — the thing a local client needs to copy. */
  apiBase: string;
  /** True when the API base is the embedded server rather than a remote one. */
  local: boolean;
  /** Prompts typed while the API was unreachable, still waiting in the queue. */
  queued?: number;
  /** Whether the last request to the API answered. Undefined means "not known yet". */
  online?: boolean;
  /** The folder the language servers and sandbox treat as the project, if one was chosen. */
  workspace?: string | null;
}

/** The menu item showing state; disabled, because it is a label and not an action. */
export function statusLabel(state: TrayState): string {
  if (state.running > 0) {
    return state.running === 1
      ? "Working — 1 run in progress"
      : `Working — ${state.running} runs in progress`;
  }
  if (state.failed > 0) {
    return state.failed === 1 ? "Idle — last run failed" : `Idle — ${state.failed} runs failed`;
  }
  return "Idle";
}

/** The tooltip, which is the only text visible while the menu is closed. */
export function trayTooltip(state: TrayState): string {
  const queued = state.queued ?? 0;
  if (state.online === false) return `Nexus — offline${queued > 0 ? `, ${queued} queued` : ""}`;
  if (queued > 0) return `Nexus — ${statusLabel(state)}, ${queued} queued`;
  return `Nexus — ${statusLabel(state)}`;
}

/** What the OS shows next to the tray icon. Empty is the right answer when idle. */
export function trayTitle(state: TrayState): string {
  return state.running > 0 ? String(state.running) : "";
}

/**
 * The path a `nexus://` link points at, or null when the link means nothing to this app.
 *
 * Only `session/<id>` exists today. Anything else is refused rather than guessed: a handler that
 * loads whatever it is given is a way to make the app fetch an arbitrary URL.
 */
export function deepLinkTarget(link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed.toLowerCase().startsWith(`${PROTOCOL}://`)) return null;

  // `nexus://session/abc` and `nexus:///session/abc` both arrive in the wild, depending on which
  // shell produced them, so the authority is dropped either way.
  const rest = trimmed.slice(`${PROTOCOL}://`.length).replace(/^\/+/, "");
  const [resource, ...tail] = rest.split("/");
  if (resource !== "session") return null;

  const id = tail.join("/").replace(/\/+$/, "");
  // A session id is a single path segment: letters, digits, dash and underscore. A slash, a dot
  // or a space in it would turn into a different route.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return `/chat/${id}`;
}

/** The session path in a deep link, including one embedded in an argv array. */
export function deepLinkFromArgs(args: readonly string[]): string | null {
  for (const arg of args) {
    const target = deepLinkTarget(arg);
    if (target) return target;
  }
  return null;
}

/** A menu row, in the shape Electron's `Menu.buildFromTemplate` takes. */
export interface TrayMenuItem {
  label: string;
  enabled?: boolean;
  click?: () => void;
  type?: "normal" | "separator";
}

/**
 * The tray menu.
 *
 * "Copy API base" is here because the desktop app is the thing that knows the address other local
 * clients need: without it, a CLI user is left reading logs to find a port. It reports the base
 * as `http://127.0.0.1:<port>` ("copy what curl needs"), never as an internal path.
 */
export function trayMenu(
  state: TrayState,
  actions: {
    copyApiBase: () => void;
    flushQueued?: () => void;
    chooseWorkspace?: () => void;
    forgetWorkspace?: () => void;
  },
): TrayMenuItem[] {
  const items: TrayMenuItem[] = [
    { label: statusLabel(state), enabled: false },
    {
      label: state.local ? `Local API — ${state.apiBase}` : `Remote API — ${state.apiBase}`,
      enabled: false,
    },
    {
      label: "Copy API base",
      click: actions.copyApiBase,
    },
  ];

  // Only shown when there is something to say: a queue row that reads "0 queued" is noise.
  const queued = state.queued ?? 0;
  if (queued > 0)
    items.push({
      label:
        state.online === false
          ? `${queued} prompt${queued === 1 ? "" : "s"} queued — waiting for the API`
          : `${queued} prompt${queued === 1 ? "" : "s"} queued — send now`,
      enabled: state.online !== false && actions.flushQueued !== undefined,
      ...(actions.flushQueued ? { click: actions.flushQueued } : {}),
    });

  if (actions.chooseWorkspace)
    items.push({
      label: state.workspace ? `Workspace: ${state.workspace}` : "Choose workspace folder…",
      click: actions.chooseWorkspace,
    });
  if (state.workspace && actions.forgetWorkspace)
    items.push({ label: "Forget workspace", click: actions.forgetWorkspace });

  return items;
}

/** The URL a client should be told about, with no trailing slash to confuse a paste. */
export function copyableApiBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}
