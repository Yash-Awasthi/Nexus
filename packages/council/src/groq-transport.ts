// SPDX-License-Identifier: Apache-2.0
/**
 * GroqTransport — ILLMTransport implementation backed by the Groq SDK.
 *
 * Drop-in replacement for any provider: the DeliberationEngine only sees
 * the ILLMTransport interface and never touches Groq SDK types directly.
 */

import Groq from "groq-sdk";

import type { ILLMTransport, ILLMMessage, ILLMResponse } from "./engine.js";

export class GroqTransport implements ILLMTransport {
  private readonly client: Groq;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GROQ_API_KEY;
    if (!key) {
      throw new Error(
        "GroqTransport requires GROQ_API_KEY — set it in env or pass apiKey to constructor",
      );
    }
    this.client = new Groq({ apiKey: key });
  }

  async chat(
    messages: ILLMMessage[],
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<ILLMResponse> {
    const start = Date.now();
    const model = options?.model ?? "llama-3.3-70b-versatile";

    const res = await this.client.chat.completions.create({
      model,
      messages: messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 512,
    });

    const content = res.choices[0]?.message?.content ?? "";

    return {
      content,
      model: res.model,
      usage: {
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - start,
    };
  }
}
