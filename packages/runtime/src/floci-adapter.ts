// SPDX-License-Identifier: Apache-2.0
/**
 * FlociExecutionAdapter — executes tasks against the Floci local AWS emulator.
 *
 * Floci is a lightweight LocalStack-compatible emulator bundled with GhostStack.
 * This adapter translates task payloads into Floci API calls and handles
 * event emission for the runtime's event bus.
 */

import { getBridgeManager } from "./bridge-manager.js";
import type { FlociHealth } from "./floci-client.js";
import { probeFlociHealth } from "./floci-client.js";
import { dispatchExtendedAction, EXTENDED_FLOCI_ACTIONS } from "./floci-extended.js";
import type { IRuntimePersistence } from "./interfaces/persistence.interface.js";

export interface FlociAdapterOptions {
  /** Reject tasks that reference unregistered Floci services when true (default: false). */
  strict?: boolean;
  /** Optional persistence layer for recording Floci operation outcomes. */
  persistence?: IRuntimePersistence;
  /** Callback invoked after each Floci action completes. */
  onEvent?: (event: string, payload: Record<string, unknown>) => Promise<void>;
}

/** Adapter that routes tasks to the Floci local AWS emulator. */
export class FlociExecutionAdapter {
  private _lastHealth?: FlociHealth;
  private readonly strict: boolean;
  private readonly persistence?: IRuntimePersistence;
  private readonly onEvent?: (event: string, payload: Record<string, unknown>) => Promise<void>;

  constructor(options: FlociAdapterOptions = {}) {
    this.strict = options.strict ?? false;
    this.persistence = options.persistence;
    this.onEvent = options.onEvent;
  }

  canExecute(taskType: string): boolean {
    return taskType === "floci" || taskType.startsWith("floci:");
  }

  async execute(task: unknown, context: unknown): Promise<Record<string, unknown>> {
    const t = task as Record<string, unknown>;
    const payload = (t.payload ?? t) as Record<string, unknown>;
    const action = String(payload.action ?? payload.type ?? "unknown");
    const service = String(payload.service ?? "generic");
    const timestamp = new Date().toISOString();
    // Route through the Floci bridge (port 4567) which translates
    // /_floci/extended/<action> calls to boto3 AWS SDK calls against the
    // real Floci emulator (floci/floci:latest) running on port 4566.
    const endpoint = await getBridgeManager().url("floci");

    // Strict mode: reject unknown actions before dispatch
    if (this.strict && !EXTENDED_FLOCI_ACTIONS.includes(action)) {
      throw new Error(
        `FlociExecutionAdapter [strict]: unknown action "${action}". ` +
          `Registered actions: ${EXTENDED_FLOCI_ACTIONS.join(", ")}`,
      );
    }

    let dispatchResult: Record<string, unknown> = {};
    let success = true;
    let dispatchError: string | undefined;

    try {
      // Real HTTP dispatch to the Floci emulator endpoint
      dispatchResult = await dispatchExtendedAction(endpoint, action, payload);
    } catch (err) {
      if (this.strict) throw err;
      // Non-strict: surface the failure but don't throw — allows graceful degradation
      // when Floci is not running (e.g. local dev without docker-compose)
      success = false;
      dispatchError = (err as Error).message;
    }

    const result: Record<string, unknown> = {
      success,
      action,
      service,
      timestamp,
      ...(dispatchError ? { error: dispatchError } : dispatchResult),
    };

    if (this.onEvent) {
      await this.onEvent("floci_action_completed", {
        ...result,
        payload,
        taskId: (context as Record<string, unknown>)?.taskId,
      });
    }

    return result;
  }

  /**
   * Execute a named Floci action with the given arguments and execution context.
   * Used by the MCP bridge for direct action dispatch.
   */
  async executeAction(
    action: string,
    args: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const task = { payload: { action, ...args } };
    const result = (await this.execute(task, context)) as Record<string, unknown>;
    return result;
  }

  async probeHealth(): Promise<FlociHealth> {
    const health = await probeFlociHealth();
    this._lastHealth = health;
    return health;
  }

  getLastHealth(): FlociHealth | undefined {
    return this._lastHealth;
  }
}
