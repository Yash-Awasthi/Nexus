// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * LocalInferenceAdapter — runs large language models locally via layer-by-layer
 * sharded inference (70B+ on 4GB VRAM, no quantization required).
 *
 * Dual role:
 *   1. IExecutionAdapter — handles "inference" task type in the task queue
 *   2. ILanguageModel    — can replace cloud providers in PlanningEngine when
 *                          GHOSTSTACK_LOCAL_MODE=1 is set
 *
 * Requires the local-inference Python bridge to be running (port 7703).
 */

import { getBridgeManager, BridgeManager } from "../runtime/bridge-manager.js";

import type { IExecutionContext } from "./interfaces/execution.interface.js";
import type {
  ILanguageModel,
  TextChunk,
  GenerateTextParams,
  StreamTextParams,
  GenerateObjectParams,
} from "./interfaces/language-model.interface.js";

// ─── Default model — small, fast, runs on 4GB VRAM ───────────────────────────
const DEFAULT_MODEL = "meta-llama/Llama-3.2-3B-Instruct";

export interface LocalInferenceOptions {
  model?: string;
  compression?: "4bit" | "8bit" | null;
  maxNewTokens?: number;
}

// ─── IExecutionAdapter implementation ────────────────────────────────────────

export class LocalInferenceAdapter {
  private opts: LocalInferenceOptions;

  constructor(opts: LocalInferenceOptions = {}) {
    this.opts = opts;
  }

  canExecute(taskType: string): boolean {
    return taskType === "inference" || taskType === "local_llm" || taskType === "generate";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const prompt: string = payload.prompt ?? payload.query ?? payload.input ?? "";
    const model: string = payload.model ?? this.opts.model ?? DEFAULT_MODEL;
    const messages: { role: string; content: string }[] = Array.isArray(payload.messages)
      ? payload.messages
      : [];

    context.logger.info(`LocalInference: model=${model} prompt="${prompt.slice(0, 60)}"`);

    try {
      const mgr = getBridgeManager();
      const baseUrl = await mgr.url("local-inference");

      const endpoint = messages.length > 0 ? "/chat" : "/generate";
      const body: Record<string, unknown> = {
        model,
        max_new_tokens: payload.maxNewTokens ?? this.opts.maxNewTokens ?? 200,
        compression: payload.compression ?? this.opts.compression ?? null,
      };
      if (messages.length > 0) {
        body.messages = messages;
      } else {
        body.prompt = prompt;
      }

      const result = await BridgeManager.post<{
        success: boolean;
        text: string;
        model: string;
        tokens_generated: number;
        error: string;
      }>(baseUrl, endpoint, body);

      if (!result.success) {
        context.logger.error(`LocalInference error: ${result.error?.slice(0, 200)}`);
        return { success: false, error: result.error };
      }

      context.logger.info(`LocalInference complete: ${result.tokens_generated} tokens`);
      return {
        success: true,
        text: result.text,
        model: result.model,
        tokensGenerated: result.tokens_generated,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

// ─── ILanguageModel implementation ───────────────────────────────────────────

export class LocalLanguageModel implements ILanguageModel {
  readonly modelId: string;
  private model: string;
  private compression: "4bit" | "8bit" | null;

  constructor(opts: LocalInferenceOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.compression = opts.compression ?? null;
    this.modelId = `local:${this.model}`;
  }

  private async callBridge(endpoint: string, body: Record<string, unknown>): Promise<string> {
    const mgr = getBridgeManager();
    const baseUrl = await mgr.url("local-inference");
    const result = await BridgeManager.post<{
      success: boolean;
      text: string;
      error: string;
    }>(baseUrl, endpoint, { ...body, model: this.model, compression: this.compression });

    if (!result.success) {
      throw new Error(`LocalInference error: ${result.error?.slice(0, 300)}`);
    }
    return result.text;
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    const messages = params.messages.map((m) => ({ role: m.role, content: m.content }));
    return this.callBridge("/chat", {
      messages,
      max_new_tokens: params.maxTokens ?? 512,
    });
  }

  async *streamText(params: StreamTextParams): AsyncIterable<TextChunk> {
    // Local inference bridge doesn't stream — emit as single chunk
    const text = await this.generateText(params);
    yield { contentChunk: text };
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    const schemaPrompt = `Respond ONLY with valid JSON matching this schema:\n${JSON.stringify(params.schema)}\nNo markdown, no explanation.`;
    const messages = [{ role: "system" as const, content: schemaPrompt }, ...params.messages];
    const raw = await this.generateText({ ...params, messages });
    const cleaned = raw
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    return JSON.parse(cleaned) as T;
  }
}
