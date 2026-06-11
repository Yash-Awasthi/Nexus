// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-groq
 *
 * Fast LLM inference via the Groq REST API.
 * Task types: groq.inference, groq.chat
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const GROQ_API_BASE = "https://api.groq.com/openai/v1";

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqInferenceTask {
  taskType: "groq.inference" | "groq.chat";
  model?: string;
  messages: GroqMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface GroqInferenceResult {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

async function execute(
  task: GroqInferenceTask,
  ctx: IExecutionContext,
): Promise<GroqInferenceResult> {
  const apiKey = requireEnv(ctx, "GROQ_API_KEY");
  const model = task.model ?? "llama-3.3-70b-versatile";
  ctx.logger.info("groq.inference", { model, messageCount: task.messages.length });

  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: task.messages,
      temperature: task.temperature ?? 0.7,
      max_tokens: task.maxTokens ?? 4096,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new AdapterHttpError("nexus-adapter-groq", response.status, await response.text());
  }

  const data = (await response.json()) as {
    id: string;
    model: string;
    choices: { message: { content: string }; finish_reason: string }[];
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const choice = data.choices[0];
  if (!choice) throw new AdapterHttpError("nexus-adapter-groq", 200, "No choices returned");

  return {
    id: data.id,
    model: data.model,
    content: choice.message.content,
    finishReason: choice.finish_reason,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}

export const groqAdapter = defineAdapter<GroqInferenceTask, GroqInferenceResult>({
  name: "nexus-adapter-groq",
  version: "0.1.0",
  capabilities: ["llm.inference"],
  taskTypes: ["groq.inference", "groq.chat"],
  execute,
});
export default groqAdapter;
