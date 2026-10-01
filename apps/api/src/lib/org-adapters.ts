// SPDX-License-Identifier: Apache-2.0
/**
 * The built-in agent adapter: one model call through Nexus's own driver stack.
 *
 * The driver comes from a resolver the route module injects — the owner's own
 * provider keys first, the server's after, with the agent's chosen model tried
 * first when one is set — so this file never touches the request stack and a
 * test can hand it a fake driver.
 */

import type { LlmResponse } from "@nexus/llm-drivers";

import type { FailoverDriver } from "./llm-failover.js";
import { CallRefused } from "./llm-failover.js";
import type { Adapter } from "./org-runtime.js";
import type { Agent } from "./org-store.js";

export interface ResolvedDriver {
  /** Always a failover chain: it is what applies the per-call budget guard. */
  driver: FailoverDriver;
  /** Model id to request; the driver fails over to others on their own models. */
  model: string;
  label: string;
}

export type DriverResolver = (modelChoice: string | null) => ResolvedDriver | undefined;

/** Reject when the run is cancelled or times out, whichever the driver does not notice. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
        return undefined;
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function nativeAdapter(
  resolve: DriverResolver,
  modelFor: (agent: Agent) => string | null,
): Adapter {
  return async (ctx) => {
    // Answer-only tasks and triage are light work, so an agent may name a cheaper model for them.
    const quick = ctx.agent.adapterConfig.quickModel;
    const light = !ctx.task || ctx.task.workMode === "ask";
    const choice =
      light && typeof quick === "string" && quick.trim() ? quick.trim() : modelFor(ctx.agent);
    const resolved = resolve(choice);
    if (!resolved)
      return {
        ok: false,
        output: "",
        error: "No LLM provider configured. Add a provider key in Settings.",
      };
    ctx.log("system", `Model: ${resolved.label}`);
    const maxTokens = Number(ctx.agent.adapterConfig.maxTokens ?? 2048) || 2048;
    const temperature = Number(ctx.agent.adapterConfig.temperature ?? 0.3);
    const chars = ctx.prompt.system.length + ctx.prompt.user.length;
    let res: LlmResponse;
    try {
      res = await abortable(
        resolved.driver.complete(
          {
            model: resolved.model,
            messages: [
              { role: "system", content: ctx.prompt.system },
              { role: "user", content: ctx.prompt.user },
            ],
            maxTokens,
            temperature,
          },
          (model) => ctx.guardCall(model, chars, maxTokens),
        ),
        ctx.signal,
      );
    } catch (err) {
      if (err instanceof CallRefused)
        return { ok: false, refused: true, output: "", error: err.message };
      throw err;
    }
    if (res.servedBy) ctx.log("system", `Served by ${res.servedBy}`);
    ctx.log("agent", res.content);
    return { ok: true, output: res.content };
  };
}
