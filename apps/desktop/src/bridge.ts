// SPDX-License-Identifier: Apache-2.0
/**
 * The host surface the desktop app exposes to the renderer.
 *
 * Kept free of Electron imports so the contract can be tested without booting
 * a browser process: `main.ts` supplies the privileged implementations and
 * `preload.ts` wires the renderer side to them over IPC.
 *
 * The renderer asks what the host can do rather than who it is (see
 * `apps/ui/app/lib/host.ts`), so this module's job is to state the capability
 * list honestly: a capability appears here only when every method behind it is
 * implemented. Anything else reaches `UnsupportedMethodError`.
 */

import type { DesktopAuth } from "./auth/session";

/** IPC channel carrying every renderer-to-host call. */
export const INVOKE_CHANNEL = "nexus-host:invoke";

/**
 * Capabilities this host claims, and the methods behind each.
 *
 * `localAccount` means the host owns the session: it holds the account token in
 * the OS keychain and hands the renderer an in-memory copy, so the renderer
 * never writes one to browser storage.
 *
 * Not claimed, and deliberately so: `deliberate`, `threads` and `memory` work
 * over HTTP against the local API and need no host path at all.
 */
export const CAPABILITY_METHODS = {
  localAccount: ["getSession", "signIn", "signInWithPassword", "refreshSession", "signOut"],
  providerSignIn: ["connectProvider", "isProviderConnected"],
  glass: ["toggleGlass"],
  councilSync: ["setCouncilMembers"],
  runMode: ["getRunMode"],
  sync: ["syncNow", "getSyncLedger"],
  /** Prompts queued while the API was unreachable; the host owns the file and the flush. */
  offlineQueue: ["queuePrompt", "getOfflineState", "flushOfflineQueue"],
  /** The folder the language servers and sandbox treat as the project. */
  workspace: ["getWorkspace", "chooseWorkspace", "clearWorkspace"],
} as const;

type DesktopCapability = keyof typeof CAPABILITY_METHODS;

export const DESKTOP_CAPABILITIES = Object.keys(CAPABILITY_METHODS) as DesktopCapability[];

export class UnsupportedMethodError extends Error {
  constructor(method: string) {
    super(
      `The desktop host does not implement "${method}". Capabilities: ${DESKTOP_CAPABILITIES.join(", ")}.`,
    );
    this.name = "UnsupportedMethodError";
  }
}

/**
 * Where the API the renderer is talking to actually runs.
 *
 * `local-only`  — the bundled service on this machine; nothing leaves it.
 * `cloud`       — a remote Nexus deployment.
 *
 * The renderer shows this, because a feature that silently answers from a
 * different place than the user thinks is worse than one that is unavailable.
 */
export type RunMode = "local-only" | "cloud";

export interface RunModeReport {
  mode: RunMode;
  /** Origin serving `/api/*`. */
  apiUrl: string;
}

/** The privileged operations `main.ts` provides. */
export interface HostImplementation {
  /** Where this window's API is running. */
  runMode(): RunModeReport;
  /** Run one sync against the configured cloud deployment. */
  syncNow(sessionId: string): Promise<unknown>;
  /** Past sync runs, newest first — the answer to "did my work get there". */
  syncLedger(): unknown[];
  /** Translucent window mode. */
  setGlass(on: boolean): void | Promise<void>;
  /** Persist council membership outside the browser's storage. */
  saveCouncilMembers(members: unknown): void | Promise<void>;
  /** Account session and provider links, both behind app-owned browser windows. */
  auth: DesktopAuth;
  /** Queue a prompt typed while the API was unreachable; returns the queue length. */
  queuePrompt?(input: { text: string; sessionId?: string | null }): Promise<number>;
  /** The queue and the connection state, for the renderer's own indicator. */
  offlineState?(): { online: boolean; queued: number };
  /** Try to send everything queued now. */
  flushOfflineQueue?(): Promise<void>;
  /** The chosen workspace folder, or null. */
  getWorkspace?(): string | null;
  /** Open the folder picker; resolves to the chosen folder, or null when cancelled. */
  chooseWorkspace?(): Promise<string | null>;
  /** Forget the chosen workspace. */
  clearWorkspace?(): void;
}

type InvokeHandler = (method: string, args: readonly unknown[]) => Promise<unknown>;

/** Route a renderer call to its implementation, or refuse it by name. */
export function createInvokeHandler(impl: HostImplementation): InvokeHandler {
  const methods: Record<string, (args: readonly unknown[]) => unknown | Promise<unknown>> = {
    toggleGlass: async (args) => {
      await impl.setGlass(args[0] === true);
      return { ok: true };
    },
    setCouncilMembers: async (args) => {
      await impl.saveCouncilMembers(args[0] ?? []);
      return { ok: true };
    },
    signIn: async (args) => impl.auth.signIn(typeof args[0] === "string" ? args[0] : "github"),
    signInWithPassword: async (args) =>
      impl.auth.signInWithPassword(String(args[0] ?? ""), String(args[1] ?? "")),
    getSession: async () => impl.auth.getSession(),
    refreshSession: async () => impl.auth.refresh(),
    signOut: async () => {
      impl.auth.signOut();
      return { ok: true };
    },
    connectProvider: async (args) => {
      await impl.auth.connectProvider(String(args[0] ?? ""));
      return { ok: true };
    },
    isProviderConnected: async (args) => impl.auth.isProviderConnected(String(args[0] ?? "")),
    getRunMode: async () => impl.runMode(),
    syncNow: async (args) => impl.syncNow(String(args[0] ?? "default")),
    getSyncLedger: async () => impl.syncLedger(),
    queuePrompt: async (args) => {
      if (!impl.queuePrompt) throw new UnsupportedMethodError("queuePrompt");
      const raw = (args[0] ?? {}) as { text?: unknown; sessionId?: unknown };
      return impl.queuePrompt({
        text: String(raw.text ?? ""),
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      });
    },
    getOfflineState: async () => {
      if (!impl.offlineState) throw new UnsupportedMethodError("getOfflineState");
      return impl.offlineState();
    },
    flushOfflineQueue: async () => {
      if (!impl.flushOfflineQueue) throw new UnsupportedMethodError("flushOfflineQueue");
      await impl.flushOfflineQueue();
      return { ok: true };
    },
    getWorkspace: async () => {
      if (!impl.getWorkspace) throw new UnsupportedMethodError("getWorkspace");
      return impl.getWorkspace();
    },
    chooseWorkspace: async () => {
      if (!impl.chooseWorkspace) throw new UnsupportedMethodError("chooseWorkspace");
      return impl.chooseWorkspace();
    },
    clearWorkspace: async () => {
      if (!impl.clearWorkspace) throw new UnsupportedMethodError("clearWorkspace");
      impl.clearWorkspace();
      return { ok: true };
    },
  };

  return async (method, args) => {
    const handler = methods[method];
    if (!handler) throw new UnsupportedMethodError(method);
    return handler(args);
  };
}

interface HostTransport {
  invoke(method: string, args: readonly unknown[]): Promise<unknown>;
}

interface ExposedHost {
  name: string;
  version: string;
  capabilities: string[];
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
}

/** The object placed on `window.nexusHost`. */
export function createHostApi(
  transport: HostTransport,
  info: { name: string; version: string },
): ExposedHost {
  return {
    name: info.name,
    version: info.version,
    capabilities: [...DESKTOP_CAPABILITIES],
    invoke: (method, ...args) => transport.invoke(method, args),
  };
}

/** Schemes the renderer may hand to the operating system; file:, smb: and custom handlers are not. */
export function isOpenableExternally(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Whether an IPC call came from a frame on the renderer's own origin, not an embedded or stray page. */
export function isTrustedSender(frameUrl: string | undefined, rendererUrl: string): boolean {
  try {
    return !!frameUrl && new URL(frameUrl).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}
