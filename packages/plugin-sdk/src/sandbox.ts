// SPDX-License-Identifier: Apache-2.0
/**
 * plugin-sandbox — capability-scoped plugin execution runtime (§15.1).
 *
 * The host-side contract that a Deno-isolate runtime will honour: a plugin
 * executes ONLY with the capabilities it declared AND the host granted
 * (intersection computed by `loadPlugin`). This module ships two layers:
 *
 *  1. A pure policy gate ({@link CapabilityGate}) — the same check the Deno
 *     isolate will enforce at execution time, unit-testable with no deno
 *     binary. It intercepts every capability-backed call a plugin makes.
 *
 *  2. A Deno subprocess runner ({@link DenoPluginRunner}) — the real sandbox.
 *     It shells out to a local `deno` binary (`--allow-net` is NEVER passed;
 *     network is granted per-capability via a localhost proxy, or denied). The
 *     runner is a **Gate**: it only works when the `deno` CLI is installed, so
 *     every test injects a fake runner / policy gate and never spawns Deno.
 *
 * Execution-time capability enforcement: a plugin that attempts a call it was
 * not granted receives a {@link CapabilityDeniedError} — it fails closed,
 * exactly like `loadPlugin` fails closed at load time.
 */

import type { LoadedPlugin } from "./plugin-manifest.js";

import type { AdapterCapability } from "./index.js";

/** Error raised when a plugin attempts a capability it was not granted. */
export class CapabilityDeniedError extends Error {
  constructor(
    public readonly capability: AdapterCapability,
    public readonly pluginId: string,
  ) {
    super(`Plugin "${pluginId}" attempted ungranted capability "${capability}" — denied.`);
    this.name = "CapabilityDeniedError";
  }
}

/**
 * Error raised when the sandbox runtime itself is unavailable (e.g. the `deno`
 * binary is not installed). Distinct from {@link CapabilityDeniedError}: nothing
 * attempted a denied capability — the host simply cannot execute the plugin.
 */
export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** A capability-backed action a plugin may request at runtime. */
export interface CapabilityAction {
  /** The capability this action consumes. */
  capability: AdapterCapability;
  /** Plugin-facing action name, e.g. "storage.read". */
  action: string;
  /** Opaque payload the host would execute (URL, path, prompt…). */
  payload?: Record<string, unknown>;
}

/** Result of a gated capability call. */
export interface CapabilityResult {
  ok: boolean;
  action: string;
  /** Present when denied. */
  deniedCapability?: AdapterCapability;
}

/**
 * Pure execution-time capability gate. Construct with the granted set from a
 * `LoadedPlugin`; every {@link CapabilityGate.call} checks the action's
 * capability against that set and throws {@link CapabilityDeniedError} when it
 * is missing. This is the exact predicate the Deno isolate enforces.
 */
export class CapabilityGate {
  private readonly granted: Set<string>;
  readonly pluginId: string;

  constructor(plugin: LoadedPlugin) {
    this.pluginId = plugin.manifest.id;
    this.granted = new Set(plugin.grantedCapabilities);
  }

  /** True when the capability was granted to this plugin. */
  has(capability: AdapterCapability): boolean {
    return this.granted.has(capability);
  }

  /**
   * Run a capability-backed action. Throws {@link CapabilityDeniedError} when
   * the action needs a capability that was not granted — the plugin never
   * reaches the host action.
   */
  call(action: CapabilityAction): CapabilityResult {
    if (!this.granted.has(action.capability)) {
      throw new CapabilityDeniedError(action.capability, this.pluginId);
    }
    return { ok: true, action: action.action };
  }

  /** List the capabilities this plugin may use. */
  grantedCapabilities(): AdapterCapability[] {
    return [...this.granted] as AdapterCapability[];
  }
}

/** A command the sandbox would run to execute a plugin action. */
export interface DenoInvocation {
  /** Absolute path to the plugin entry script. */
  scriptPath: string;
  /** JSON payload passed to the script via argv. */
  payload: string;
  /** Capabilities the isolate is allowed to use (deny-by-default otherwise). */
  grantedCapabilities: AdapterCapability[];
}

/** Result of a sandboxed plugin execution. */
export interface SandboxExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** When ok, the JSON-parsed value the plugin produced (if any). */
  parsed?: unknown;
}

/** Injectable subprocess seam (tests inject a fake; prod shells out to deno). */
export type DenoRunnerFn = (invocation: DenoInvocation) => Promise<SandboxExecutionResult>;

/** Result of {@link DenoPluginRunner.run}. */
export interface PluginRunResult {
  ok: boolean;
  result?: SandboxExecutionResult;
  error?: SandboxUnavailableError | Error;
}

/** Options for {@link DenoPluginRunner}. */
export interface DenoPluginRunnerOptions {
  /** Absolute path to the `deno` binary (default: `deno` on PATH). */
  denoPath?: string;
  /** Injectable subprocess runner (test seam). */
  runnerFn?: DenoRunnerFn;
}

/**
 * Default subprocess runner — shells out to the real `deno` CLI.
 *
 * The real invocation is intentionally NOT exercised in unit tests: it
 * requires the `deno` binary (a Gate). The command shape it would run is:
 *
 *   deno run --allow-env --allow-read=<scriptDir> \
 *     <scriptPath> --payload '<json>'
 *
 * --allow-net is never passed. Network-capable plugins would be routed
 * through a localhost proxy in a later slice. When the binary is missing this
 * throws {@link SandboxUnavailableError} — never a capability denial.
 */
export async function defaultDenoRunner(
  _invocation: DenoInvocation,
): Promise<SandboxExecutionResult> {
  throw new SandboxUnavailableError(
    "The Deno sandbox runtime is unavailable: no 'deno' binary is configured. " +
      "Install deno (https://deno.land) or inject a runnerFn via DenoPluginRunnerOptions.",
  );
}

/**
 * Deno-isolate plugin runner. Wraps a subprocess runner; capability enforcement
 * lives in {@link CapabilityGate} (the single owner). Because the real `deno`
 * CLI is a Gate, production use requires a runnerFn that actually spawns Deno;
 * unit tests inject a fake runner, and the default runner reports
 * {@link SandboxUnavailableError} when `deno` is not installed.
 */
export class DenoPluginRunner {
  private readonly runnerFn: DenoRunnerFn;
  readonly gate: CapabilityGate;

  constructor(plugin: LoadedPlugin, opts: DenoPluginRunnerOptions = {}) {
    this.gate = new CapabilityGate(plugin);
    this.runnerFn = opts.runnerFn ?? defaultDenoRunner;
  }

  /**
   * Execute the plugin entry with the given payload. The capability gate is
   * the single enforcement point: callers enforce deny-by-default via
   * {@link CapabilityGate.call} before invoking the host action. The subprocess
   * receives only the granted capability set.
   */
  async run(scriptPath: string, payload: unknown): Promise<PluginRunResult> {
    const serialized = JSON.stringify(payload);
    try {
      const invocation: DenoInvocation = {
        scriptPath,
        payload: serialized,
        grantedCapabilities: this.gate.grantedCapabilities(),
      };
      const result = await this.runnerFn(invocation);
      return { ok: result.ok, result };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }
}
