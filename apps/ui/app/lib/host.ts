// SPDX-License-Identifier: Apache-2.0
/**
 * Host bridge — what the surrounding application can do, not which one it is.
 *
 * The renderer ships in two forms: a browser tab and the desktop app. A branch
 * that asks "is this Electron?" bakes one host's name into feature code and
 * breaks the moment a second host exists, so nothing here asks. A host declares
 * a capability list; the renderer asks whether a capability is present and
 * falls back to the web path when it is not.
 *
 * A host that claims a capability must implement it. A method reached without
 * its capability throws `HostUnsupportedError` rather than returning undefined,
 * because a silent no-op is how a feature ends up half-working on one platform.
 */

/**
 * Capabilities a host may declare. Each one is something the web path cannot
 * do, or does differently:
 *
 *   localAccount   — the host owns the session; skip cloud sign-in.
 *   deliberate     — the host runs deliberations itself and emits their events.
 *   threads        — the host stores threads and messages locally.
 *   memory         — the host stores the user's long-term memory locally.
 *   glass          — the host's window supports the translucent mode.
 *   councilSync    — the host persists council membership outside the browser.
 *   providerSignIn — the host can drive a real browser window for provider
 *                    sign-in, so a user need not paste an API key.
 *   runMode        — the host can say where the API it serves actually runs.
 *   sync           — the host can sync with a cloud deployment and report what
 *                    moved.
 */
type HostCapability =
  | "localAccount"
  | "deliberate"
  | "threads"
  | "memory"
  | "glass"
  | "councilSync"
  | "providerSignIn"
  | "runMode"
  | "sync";

interface HostBridge {
  /** Identifies the host in diagnostics. Never branch on it. */
  name: string;
  version?: string;
  capabilities: readonly string[];
  invoke: (method: string, ...args: unknown[]) => Promise<unknown>;
  /** Absent when the host emits no events. */
  on?: (event: string, callback: (detail: unknown) => void) => () => void;
}

export class HostUnsupportedError extends Error {
  constructor(capability: HostCapability, method: string) {
    super(`The current host does not support "${capability}" (requested: ${method}).`);
    this.name = "HostUnsupportedError";
  }
}

/** The bridge a host installed on the window, or null in a plain browser tab. */
export function host(): HostBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { nexusHost?: HostBridge }).nexusHost;
  return bridge && typeof bridge.invoke === "function" ? bridge : null;
}

export function isHosted(): boolean {
  return host() !== null;
}

export function hostCan(capability: HostCapability): boolean {
  return host()?.capabilities.includes(capability) ?? false;
}

/** Call a host method. Throws unless the host declared `capability`. */
export async function hostInvoke<T>(
  capability: HostCapability,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const bridge = host();
  if (!bridge || !bridge.capabilities.includes(capability)) {
    throw new HostUnsupportedError(capability, method);
  }
  return (await bridge.invoke(method, ...args)) as T;
}

/** Subscribe to a host event. Returns a no-op unsubscribe when unavailable. */
export function hostOn(event: string, callback: (detail: unknown) => void): () => void {
  const bridge = host();
  if (!bridge?.on) return () => {};
  return bridge.on(event, callback);
}

/**
 * Where the API this renderer talks to is running: `local-only` is a service
 * on this machine, `cloud` a remote deployment. A plain browser tab is always
 * cloud; a host that cannot say returns null rather than guessing, because a
 * wrong answer here tells the user their data went somewhere it did not.
 */
type RunMode = "local-only" | "cloud";

interface RunModeReport {
  mode: RunMode;
  apiUrl: string;
}

export async function runMode(): Promise<RunModeReport | null> {
  if (!isHosted()) return { mode: "cloud", apiUrl: window.location.origin };
  if (!hostCan("runMode")) return null;
  try {
    return await hostInvoke<RunModeReport>("runMode", "getRunMode");
  } catch {
    return null;
  }
}
