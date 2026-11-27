// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /v1/responses` — OpenAI's Responses API on the same surface as `/v1/chat/completions`.
 *
 * Current OpenAI SDKs default to this endpoint, so a client that only implements
 * `/chat/completions` answers "404" to the call its own documentation shows first. The
 * mapping is not one-to-one and pretending otherwise would be worse than not having it, so
 * what follows is written down rather than inferred:
 *
 *   | Responses API              | here                                                       |
 *   | -------------------------- | ---------------------------------------------------------- |
 *   | `input` (string)           | one `user` turn                                             |
 *   | `input` (items)            | `message` items in order, `function_call` / `function_call_output` items as a tool turn |
 *   | `instructions`             | the system prompt; concatenated with any `system`/`developer` message |
 *   | `tools[].name` (flat)      | the driver's tool definition; the nested chat shape is also accepted |
 *   | `max_output_tokens`        | `maxTokens`                                                 |
 *   | `store` + `previous_response_id` | a record in `nexus_kv` (`openai_responses`, 7-day TTL) that a follow-up continues |
 *   | `output_text`              | the concatenated text of every `output_text` part           |
 *
 * What is deliberately not implemented: `background`, `include`, `truncation: "auto"`,
 * `audio`, `file_search`/`web_search` hosted tools, and `reasoning` items. A request naming
 * one of those is refused with `unsupported_parameter` rather than silently answered
 * differently — an SDK retrying a silently-ignored parameter is a bug report nobody can read.
 */
import { randomUUID } from "node:crypto";

import type {
  LlmMessage,
  LlmRequestOptions,
  LlmResponse,
  LlmToolDefinition,
} from "@nexus/llm/drivers";
import type { FastifyInstance, FastifyReply } from "fastify";

import { PersistentStore } from "../lib/persistent-store.ts";
import { openaiError } from "../lib/reply-errors.ts";

import { resolveModel } from "./openai.ts";

type Part = { type?: string; text?: string };

interface InputItem {
  type?: string;
  role?: string;
  content?: string | Part[] | null;
  /** `function_call` / `function_call_output` items carry these instead of `content`. */
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
}

interface ToolInput {
  type?: string;
  name?: string;
  description?: string;
  parameters?: object;
  /** The chat-completions shape, accepted because clients mix the two up. */
  function?: { name?: string; description?: string; parameters?: object };
}

interface ResponsesBody {
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ToolInput[];
  tool_choice?: unknown;
  previous_response_id?: unknown;
  store?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

/** Parameters the Responses API documents that this endpoint cannot honour. */
const UNSUPPORTED = [
  "background",
  "include",
  "audio",
  "conversation",
  "prompt",
  "reasoning",
  "text",
  "truncation",
] as const;

/** A turn kept for `previous_response_id`; retention is stated once, here. */
export interface StoredResponse {
  id: string;
  createdAt: number;
  model: string;
  /** The conversation as the driver saw it, so a follow-up continues rather than restarts. */
  messages: LlmMessage[];
  systemPrompt?: string;
}

const responses = new PersistentStore<StoredResponse>("openai_responses");
/** A stored response older than this is not worth keeping; the conversation is the record. */
export const RESPONSE_TTL_MS = 7 * 24 * 3600_000;

let _loaded: Promise<void> | null = null;
function loaded(): Promise<void> {
  _loaded ??= responses.load();
  return _loaded;
}

/** The text of one content value: a string, or the `text` of every text part. */
export function contentText(content: InputItem["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        part?.type === undefined ||
        part.type === "input_text" ||
        part.type === "output_text" ||
        part.type === "text",
    )
    .map((part) => part?.text ?? "")
    .join("");
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    // A model can emit a half-finished object; an empty argument set is the only
    // answer that keeps the turn parseable.
    return {};
  }
}

/**
 * The request as the driver contract: `instructions` and any system/developer item become
 * the system prompt, `function_call_output` becomes a tool result, and everything else is a
 * message in order.
 */
export function toConversation(
  body: ResponsesBody,
  prior?: StoredResponse,
): { messages: LlmMessage[]; systemPrompt?: string } {
  const items: InputItem[] =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : Array.isArray(body.input)
        ? (body.input as InputItem[])
        : [];

  const instructions =
    typeof body.instructions === "string" && body.instructions.trim() ? [body.instructions] : [];
  const messages: LlmMessage[] = prior ? [...prior.messages] : [];
  const system = prior?.systemPrompt ? [prior.systemPrompt] : [];

  for (const item of items) {
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        ...(item.call_id ? { toolCallId: item.call_id } : {}),
      });
      continue;
    }
    if (item.type === "function_call") {
      // The assistant turn that asked for the call, so the tool result has a parent.
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: item.call_id ?? item.name ?? "call_0",
            name: item.name ?? "",
            arguments: parseArgs(item.arguments),
          },
        ],
      });
      continue;
    }
    if (item.role === "system" || item.role === "developer") {
      const text = contentText(item.content);
      if (text.trim()) system.push(text);
      continue;
    }
    if (item.role || item.type === undefined || item.type === "message") {
      messages.push({
        role: (item.role === "assistant" ? "assistant" : "user") as LlmMessage["role"],
        content: contentText(item.content),
      });
    }
  }

  const systemPrompt = [...system, ...instructions].filter(Boolean).join("\n\n");
  return { messages, ...(systemPrompt ? { systemPrompt } : {}) };
}

/** Tools, flat (Responses) or nested (chat) — clients send both, sometimes in one array. */
export function toTools(tools: ToolInput[] | undefined): LlmToolDefinition[] | undefined {
  const mapped = (tools ?? [])
    .map((tool) => {
      const name = tool.name ?? tool.function?.name;
      if (!name) return null;
      return {
        name,
        description: tool.description ?? tool.function?.description ?? "",
        parameters: (tool.parameters ??
          tool.function?.parameters ?? { type: "object", properties: {} }) as Record<
          string,
          unknown
        >,
      } satisfies LlmToolDefinition;
    })
    .filter((tool): tool is LlmToolDefinition => tool !== null);
  return mapped.length ? mapped : undefined;
}

/** The driver request for one Responses call. */
export function toRequest(
  body: ResponsesBody,
  model: string,
  prior?: StoredResponse,
): LlmRequestOptions {
  const { messages, systemPrompt } = toConversation(body, prior);
  const tools = toTools(body.tools);
  const choice = body.tool_choice;
  return {
    model,
    messages,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(body.max_output_tokens !== undefined ? { maxTokens: body.max_output_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(tools ? { tools } : {}),
    ...(choice === "auto" || choice === "none" || choice === "required"
      ? { toolChoice: choice }
      : {}),
  };
}

/** A response object as the SDK parses it: `output` items plus the `output_text` convenience. */
export function responseObject(input: {
  id: string;
  createdAt: number;
  model: string;
  res: LlmResponse;
  status?: "completed" | "incomplete" | "failed";
  metadata?: unknown;
}): Record<string, unknown> {
  const { id, createdAt, model, res } = input;
  const output: Record<string, unknown>[] = [];

  if (res.content?.length) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: res.content, annotations: [] }],
    });
  }
  for (const call of res.toolCalls ?? []) {
    output.push({
      type: "function_call",
      id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      call_id: call.id || `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
      status: "completed",
    });
  }

  return {
    id,
    object: "response",
    created_at: createdAt,
    status: input.status ?? "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    output_text: res.content ?? "",
    parallel_tool_calls: true,
    previous_response_id: null,
    store: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: res.usage.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: res.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: res.usage.inputTokens + res.usage.outputTokens,
    },
    metadata: (input.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

const invalid = (reply: FastifyReply, message: string, extra?: Record<string, unknown>) =>
  openaiError(reply, 400, "invalid_request_error", message, extra);

const upstream = (err: unknown) => ({
  error: {
    message: err instanceof Error ? err.message : String(err),
    type: "upstream_error",
    code: null,
  },
});

/** The response body an SSE event carries: the finished object, or the in-progress one. */
function inProgress(id: string, createdAt: number, model: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [],
    output_text: "",
    usage: null,
  };
}

export async function openaiResponsesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ResponsesBody }>("/responses", async (request, reply) => {
    const body = request.body ?? {};
    const named = UNSUPPORTED.filter((key) => body[key] !== undefined);
    if (named.length) {
      return invalid(reply, `This endpoint does not implement ${named.join(", ")}.`, {
        param: named[0],
        code: "unsupported_parameter",
      });
    }
    if (typeof body.model !== "string") return invalid(reply, "model is required");
    if (body.input === undefined) return invalid(reply, "input is required");

    await loaded();
    const store = responses.for(request);
    let prior: StoredResponse | undefined;
    if (typeof body.previous_response_id === "string") {
      const id = body.previous_response_id;
      prior = store.get(id);
      if (!prior) {
        // Another process may hold the turn; ask the backing store once before refusing.
        prior = (await responses.refresh(`${request.nexusUserId ?? "anonymous"}::${id}`)) as
          | StoredResponse
          | undefined;
        if (prior?.createdAt && Date.now() - prior.createdAt > RESPONSE_TTL_MS) prior = undefined;
      }
      if (!prior) {
        return openaiError(
          reply,
          404,
          "invalid_request_error",
          `No stored response with id ${id}. Responses expire after 7 days.`,
          { code: "previous_response_not_found", param: "previous_response_id" },
        );
      }
    }

    const { driver, model } = await resolveModel(body.model, request.nexusUserId);
    if (!driver) return invalid(reply, "No provider key is saved for this account.");
    const opts = toRequest(body, model, prior);
    const id = `resp_${randomUUID().replace(/-/g, "")}`;
    const createdAt = Math.floor(Date.now() / 1000);

    if (!body.stream) {
      let res: LlmResponse;
      try {
        res = (await driver.complete(opts)) as LlmResponse & { servedBy?: string };
      } catch (err) {
        return reply.code(502).send(upstream(err));
      }
      if ((res as { servedBy?: string }).servedBy)
        reply.header("x-nexus-served-by", (res as { servedBy?: string }).servedBy);
      if (body.store !== false) remember(store, id, createdAt, body.model, opts, res);
      return responseObject({ id, createdAt, model: body.model, res, metadata: body.metadata });
    }

    // ── streamed: the documented event sequence, one event per write ──────────
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let seq = 0;
    const emit = (type: string, payload: Record<string, unknown>) => {
      raw.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`,
      );
    };

    emit("response.created", { response: inProgress(id, createdAt, body.model) });
    emit("response.in_progress", { response: inProgress(id, createdAt, body.model) });

    const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    emit("response.output_item.added", {
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    emit("response.content_part.added", {
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });

    let text = "";
    try {
      const res = (await driver.stream(opts, (delta) => {
        if (delta.delta) {
          text += delta.delta;
          emit("response.output_text.delta", {
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: delta.delta,
          });
        }
        // Partial tool-call arguments: the SDK assembles the call from these, so a
        // client that shows "calling search(…)" needs them before the turn ends.
        for (const partial of delta.toolCallDeltas ?? []) {
          emit("response.function_call_arguments.delta", {
            item_id: partial.id ?? `fc_${partial.index ?? 0}`,
            output_index: 0,
            delta: partial.argumentsDelta ?? "",
          });
        }
      })) as LlmResponse;
      emit("response.output_text.done", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      });
      emit("response.content_part.done", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
      emit("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: messageId,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      });
      const done = responseObject({
        id,
        createdAt,
        model: body.model,
        res: { ...res, content: text },
        metadata: body.metadata,
      });
      const items = (
        done.output as {
          type: string;
          call_id?: string;
          name?: string;
          arguments?: string;
          id: string;
        }[]
      ).filter((item) => item.type === "function_call");
      let index = 1;
      for (const call of items) {
        emit("response.output_item.added", {
          output_index: index,
          item: { ...call, status: "in_progress" },
        });
        emit("response.function_call_arguments.done", {
          item_id: call.id,
          output_index: index,
          arguments: call.arguments ?? "{}",
        });
        emit("response.output_item.done", { output_index: index, item: call });
        index++;
      }
      emit("response.completed", { response: done });
      if (body.store !== false)
        remember(store, id, createdAt, body.model, opts, { ...res, content: text });
    } catch (err) {
      emit("response.failed", {
        response: {
          ...inProgress(id, createdAt, body.model),
          status: "failed",
          error: (upstream(err) as { error: unknown }).error,
        },
      });
    }
    raw.end("data: [DONE]\n\n");
  });

  /** A stored turn, for a client that keeps only the id. */
  app.get<{ Params: { id: string } }>("/responses/:id", async (request, reply) => {
    await loaded();
    const record = responses.for(request).get(request.params.id);
    if (!record) {
      return openaiError(
        reply,
        404,
        "invalid_request_error",
        `No stored response with id ${request.params.id}.`,
        {
          code: "not_found",
        },
      );
    }
    return {
      id: record.id,
      object: "response",
      created_at: record.createdAt,
      status: "completed",
      model: record.model,
      output: record.messages
        .filter((m) => m.role === "assistant")
        .map((m) => ({
          type: "message",
          id: `msg_${record.id.slice(-12)}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: m.content, annotations: [] }],
        })),
      output_text: record.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join("\n"),
    };
  });

  /** `store: false` means the client does not want it back; deleting a kept one is the same idea. */
  app.delete<{ Params: { id: string } }>("/responses/:id", async (request) => {
    await loaded();
    responses.for(request).delete(request.params.id);
    return { id: request.params.id, object: "response.deleted", deleted: true };
  });
}

/**
 * Keep the turn so a follow-up can continue it: the conversation as it was sent, plus the
 * assistant's answer, which is exactly what `previous_response_id` has to replay.
 */
function remember(
  store: ReturnType<PersistentStore<StoredResponse>["for"]>,
  id: string,
  createdAt: number,
  model: string,
  opts: LlmRequestOptions,
  res: LlmResponse,
): void {
  const assistant: LlmMessage = {
    role: "assistant",
    content: res.content ?? "",
    ...(res.toolCalls?.length ? { toolCalls: res.toolCalls } : {}),
  };
  store.set(id, {
    id,
    createdAt,
    model,
    messages: [...opts.messages, assistant],
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
  });
}
