// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck — imports reference orchestration modules not yet exported from @nexus/runtime public API
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { getBridgeManager, BridgeManager } from "../runtime/bridge-manager.js";

import type {
  IBrowserExecutionAdapter,
  IBrowserTask,
  IEnvironmentTelemetry,
} from "./interfaces/environment.interface.js";
import type { IExecutionContext } from "./interfaces/execution.interface.js";
import { isSafeUrl } from "./security-utils.js";

export class BrowserExecutionAdapter implements IBrowserExecutionAdapter {
  constructor(
    private telemetry: IEnvironmentTelemetry,
    private isOfflineMode = true,
  ) {}

  canExecute(taskType: string): boolean {
    return taskType === "browser";
  }

  async execute(task: any, context: IExecutionContext): Promise<any> {
    const payload = task.payload || {};
    const browserTask: IBrowserTask = {
      id: context.taskId,
      url: payload.url || "",
      actions: payload.actions || [],
      timeoutMs: payload.timeoutMs || 5000,
    };
    return this.executeBrowserTask(browserTask);
  }

  async executeBrowserTask(
    task: IBrowserTask,
  ): Promise<{ success: boolean; screenshotUrl?: string; content?: string; logs: string[] }> {
    const logs: string[] = [];
    logs.push(`Initiating browser task execution for: ${task.url}`);

    // Safety Policy verification
    if (!isSafeUrl(task.url)) {
      logs.push(`Safety Policy Block: Forbidden URL protocol/host: ${task.url}`);
      return {
        success: false,
        content: "BLOCKED_BY_SAFETY_POLICY",
        logs,
      };
    }

    this.telemetry.browserSessionsActive += 1;
    this.telemetry.recordNavigation(task.url);

    if (this.isOfflineMode) {
      logs.push(`Simulating offline execution context for browser task...`);

      // Simulate timeout bounds
      if (task.timeoutMs <= 50) {
        this.telemetry.browserSessionsActive -= 1;
        logs.push(`Session timeout breached limits of ${task.timeoutMs}ms.`);
        return {
          success: false,
          content: "TIMEOUT_BREACHED",
          logs,
        };
      }

      for (const action of task.actions) {
        logs.push(
          `Executing interactive event: ${action.type} (Selector: ${action.selector || "none"})`,
        );
        if (action.type === "navigate" && action.value) {
          if (!isSafeUrl(action.value)) {
            this.telemetry.browserSessionsActive -= 1;
            logs.push(`Safety Policy Block: Forbidden redirect URL: ${action.value}`);
            return {
              success: false,
              content: "BLOCKED_BY_SAFETY_POLICY",
              logs,
            };
          }
          this.telemetry.recordNavigation(action.value);
        }
      }

      this.telemetry.browserSessionsActive -= 1;
      return {
        success: true,
        screenshotUrl: `http://localhost:4566/screenshots/${task.id}.png`,
        content: `<html><body>Mock page loaded: ${task.url}</body></html>`,
        logs,
      };
    }

    // Stealth browser execution via patched Chromium bridge (anti-bot bypass)
    try {
      const mgr = getBridgeManager();
      const baseUrl = await mgr.url("stealth-browser");
      logs.push("Stealth browser bridge connection established.");

      const endpoint = task.actions.length > 0 ? "/interact" : "/browse";
      const requestBody: Record<string, unknown> = {
        url: task.url,
        headless: true,
        humanize: true,
        timeout_ms: task.timeoutMs || 30_000,
        disable_resources: false,
      };
      if (task.actions.length > 0) {
        requestBody.actions = task.actions.map((a) => ({
          type: a.type,
          selector: a.selector ?? null,
          value: a.value ?? null,
        }));
      }

      const result = await BridgeManager.post<{
        success: boolean;
        html: string;
        title: string;
        final_url: string;
        screenshot_b64: string;
        error: string;
      }>(baseUrl, endpoint, requestBody);

      this.telemetry.browserSessionsActive -= 1;

      if (!result.success) {
        logs.push(`Stealth browser error: ${result.error}`);
        return { success: false, content: result.error, logs };
      }

      logs.push(`Page loaded: ${result.title} (${result.final_url})`);
      return {
        success: true,
        content: result.html,
        ...(result.screenshot_b64
          ? { screenshotUrl: `data:image/png;base64,${result.screenshot_b64}` }
          : {}),
        logs,
      };
    } catch (err: any) {
      this.telemetry.browserSessionsActive -= 1;
      logs.push(`Stealth browser execution failure: ${err.message}`);
      return {
        success: false,
        content: `Error: ${err.message}`,
        logs,
      };
    }
  }
}
