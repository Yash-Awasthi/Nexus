// SPDX-License-Identifier: Apache-2.0
/**
 * Language model providers for Conductor.
 *
 * GroqModelProvider  — fast cloud inference via Groq REST API
 * FreeModelProvider  — multi-backend routing (OpenRouter / Ollama / local)
 *
 * Both implement ILanguageModel so all consumers are backend-agnostic.
 */

import * as http from "http";
import * as https from "https";

import type {
  ILanguageModel,
  ChatMessage,
  TextChunk,
  GenerateTextParams,
  StreamTextParams,
  GenerateObjectParams,
} from "./interfaces/language-model.interface.js";

// ─── Shared HTTP helpers ──────────────────────────────────────────────────────

function httpsPost(url: string, headers: Record<string, string>, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = (parsed.protocol === "https:" ? https : http).request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function* streamHttpsPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): AsyncIterable<string> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  const options: https.RequestOptions = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      ...headers,
    },
  };

  const chunks: string[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const req = (parsed.protocol === "https:" ? https : http).request(options, (res) => {
    res.on("data", (c: Buffer) => {
      chunks.push(c.toString("utf8"));
      resolve?.();
      resolve = null;
    });
    res.on("end", () => {
      done = true;
      resolve?.();
      resolve = null;
    });
  });
  req.on("error", () => {
    done = true;
    resolve?.();
    resolve = null;
  });
  req.write(payload);
  req.end();

  while (!done || chunks.length > 0) {
    if (chunks.length === 0) {
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
    const chunk = chunks.shift();
    if (chunk !== undefined) yield chunk;
  }
}

// ─── SSE line parser ─────────────────────────────────────────────────────────

function* _parseSseLines(raw: string): Iterable<string> {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
      yield trimmed.slice(6);
    }
  }
}

// ─── GroqModelProvider ───────────────────────────────────────────────────────

const GROQ_API_BASE = "https://api.groq.com/openai/v1";

class GroqModelProvider implements ILanguageModel {
  readonly modelId: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "llama-3.3-70b-versatile";
    this.modelId = `groq:${this.model}`;
  }

  private get authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private buildMessages(params: GenerateTextParams): unknown[] {
    return params.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.buildMessages(params),
      max_tokens: params.maxTokens ?? 2048,
      temperature: params.temperature ?? 0.7,
    };
    if (params.tools) body.tools = params.tools;

    const raw = await httpsPost(`${GROQ_API_BASE}/chat/completions`, this.authHeader, body);
    const parsed = JSON.parse(raw);
    return parsed?.choices?.[0]?.message?.content ?? "";
  }

  async *streamText(params: StreamTextParams): AsyncIterable<TextChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.buildMessages(params),
      max_tokens: params.maxTokens ?? 2048,
      temperature: params.temperature ?? 0.7,
      stream: true,
    };
    if (params.tools) body.tools = params.tools;

    let buffer = "";
    for await (const raw of streamHttpsPost(
      `${GROQ_API_BASE}/chat/completions`,
      this.authHeader,
      body,
    )) {
      buffer += raw;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json?.choices?.[0]?.delta;
          const content: string = delta?.content ?? "";
          if (content) yield { contentChunk: content };
        } catch {
          // partial JSON — ignore
        }
      }
    }
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    // Only prepend the extraction system prompt when the caller hasn't already
    // provided one — avoids conflicting dual system messages (e.g. from classify()).
    const callerHasSystemMessage = params.messages.some((m) => m.role === "system");
    const schemaMsg: ChatMessage = {
      role: "user",
      content: `JSON Schema to conform to:\n${JSON.stringify(params.schema, null, 2)}`,
    };
    const prefixMessages: ChatMessage[] = callerHasSystemMessage
      ? [schemaMsg]
      : [
          {
            role: "system",
            content:
              "You are a structured data extractor. Respond ONLY with valid JSON matching the schema provided. No explanation, no markdown fences.",
          },
          schemaMsg,
        ];
    const body = {
      model: this.model,
      messages: [...prefixMessages, ...params.messages].map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.2,
      response_format: { type: "json_object" },
    };
    const raw = await httpsPost(`${GROQ_API_BASE}/chat/completions`, this.authHeader, body);
    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(content) as T;
  }
}

// ─── FreeModelProvider ───────────────────────────────────────────────────────
// Multi-backend routing: tries providers in order, falls back on error.
// Provider strings: "openrouter:<model>", "ollama:<model>", "groq:<model>"

type ProviderRoute = `openrouter:${string}` | `ollama:${string}` | `groq:${string}`;

interface FreeModelProviderConfig {
  routes: ProviderRoute[];
  /** API keys per provider */
  keys?: {
    openrouter?: string;
    groq?: string;
  };
  /** Base URL for local Ollama (default http://localhost:11434) */
  ollamaBase?: string;
}

class FreeModelProvider implements ILanguageModel {
  readonly modelId: string;
  private readonly config: FreeModelProviderConfig;
  private readonly ollamaBase: string;

  constructor(config: FreeModelProviderConfig) {
    this.config = config;
    this.ollamaBase = config.ollamaBase ?? "http://localhost:11434";
    this.modelId = `free:${config.routes[0] ?? "unrouted"}`;
  }

  private async tryRoute(route: ProviderRoute, params: GenerateTextParams): Promise<string | null> {
    const [provider, model] = route.split(":") as [string, string];
    try {
      if (provider === "groq" && this.config.keys?.groq) {
        const g = new GroqModelProvider({ apiKey: this.config.keys.groq, model });
        return await g.generateText(params);
      }
      if (provider === "openrouter" && this.config.keys?.openrouter) {
        const body = {
          model,
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: params.maxTokens ?? 2048,
        };
        const raw = await httpsPost(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            Authorization: `Bearer ${this.config.keys.openrouter}`,
            "HTTP-Referer": "https://github.com/Yash-Awasthi/Ghoststack",
          },
          body,
        );
        return JSON.parse(raw)?.choices?.[0]?.message?.content ?? null;
      }
      if (provider === "ollama") {
        const body = {
          model,
          prompt: params.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
          stream: false,
        };
        const raw = await httpsPost(`${this.ollamaBase}/api/generate`, {}, body);
        return JSON.parse(raw)?.response ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    for (const route of this.config.routes) {
      const result = await this.tryRoute(route, params);
      if (result !== null) return result;
    }
    throw new Error(`FreeModelProvider: all routes exhausted (${this.config.routes.join(", ")})`);
  }

  async *streamText(params: StreamTextParams): AsyncIterable<TextChunk> {
    // Use native streaming for groq routes; single-chunk fallback for others.
    for (const route of this.config.routes) {
      const [provider, model] = route.split(":") as [string, string];
      if (provider === "groq" && this.config.keys?.groq) {
        const g = new GroqModelProvider({ apiKey: this.config.keys.groq, model });
        yield* g.streamText(params);
        return;
      }
      // Non-groq routes don't expose a streaming endpoint here — emit as single chunk
      const text = await this.tryRoute(route, params);
      if (text !== null) {
        yield { contentChunk: text };
        return;
      }
    }
    throw new Error(
      `FreeModelProvider: all routes exhausted for streaming (${this.config.routes.join(", ")})`,
    );
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    const augmented: GenerateTextParams = {
      ...params,
      messages: [
        {
          role: "system",
          content: "Respond ONLY with valid JSON matching the schema. No markdown fences.",
        },
        {
          role: "user",
          content: `Schema:\n${JSON.stringify(params.schema)}\n\nMessages:\n${params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")}`,
        },
      ],
    };
    const raw = await this.generateText(augmented);
    // Strip markdown code fences if model added them
    const cleaned = raw
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    return JSON.parse(cleaned) as T;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createLanguageModel(opts: {
  provider: "groq" | "free";
  groqApiKey?: string;
  groqModel?: string;
  freeConfig?: FreeModelProviderConfig;
}): ILanguageModel {
  if (opts.provider === "groq" && opts.groqApiKey) {
    return new GroqModelProvider({ apiKey: opts.groqApiKey, model: opts.groqModel });
  }
  if (opts.provider === "free" && opts.freeConfig) {
    return new FreeModelProvider(opts.freeConfig);
  }
  // Default: Groq from env
  const key = process.env.GROQ_API_KEY ?? "";
  return new GroqModelProvider({ apiKey: key, model: opts.groqModel });
}
