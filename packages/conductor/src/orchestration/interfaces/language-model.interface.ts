// SPDX-License-Identifier: Apache-2.0
/**
 * ILanguageModel — unified abstraction over any text generation backend.
 *
 * Implementations: GroqModelProvider, FreeModelProvider (local/free routing)
 * Consumers: PlanningEngine (AI-powered plan generation), WebSearchEngine
 *            (query classification + answer synthesis), CodeAgentPool (agent reasoning)
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool call id — required when role === "tool" */
  tool_call_id?: string;
  /** Tool calls emitted by assistant */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-serialised
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface TextChunk {
  contentChunk: string;
  toolCallChunks?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface GenerateTextParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

// StreamTextParams is intentionally identical to GenerateTextParams —
// kept as a distinct named type so call-sites remain self-documenting.
export type StreamTextParams = GenerateTextParams;

export interface GenerateObjectParams<_T = unknown> {
  messages: ChatMessage[];
  /** Zod-compatible JSON Schema object */
  schema: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface ILanguageModel {
  /** Model identifier (e.g. "groq:llama-3.3-70b-versatile") */
  readonly modelId: string;

  /** Single-shot text generation */
  generateText(params: GenerateTextParams): Promise<string>;

  /** Streaming text — yields chunks as they arrive */
  streamText(params: StreamTextParams): AsyncIterable<TextChunk>;

  /** Structured JSON output matching the provided schema */
  generateObject<T = unknown>(params: GenerateObjectParams<T>): Promise<T>;
}
