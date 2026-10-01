// SPDX-License-Identifier: Apache-2.0
/**
 * The OpenAI API at /v1: any OpenAI client works with Nexus by pointing its base URL here.
 *
 *   GET  /v1/models            — every model the caller's saved keys (and the server's) reach
 *   POST /v1/chat/completions  — JSON or SSE, tools both ways
 *   POST /v1/completions       — legacy prompt API, answered as one chat turn
 *   POST /v1/embeddings       — relayed to the named provider's own endpoint
 *
 * A model is "provider/model", e.g. "groq/openai/gpt-oss-20b"; the named provider answers first
 * and the rest of the caller's chain takes over if it fails. Any other name uses the default chain.
 */
import { randomUUID } from "node:crypto";

import type {
  LlmMessage,
  LlmRequestOptions,
  LlmResponse,
  LlmToolCall,
  LlmToolDefinition,
} from "@nexus/llm-drivers";
import type { FastifyInstance, FastifyReply } from "fastify";

import { getProviderSnapshot, type FailoverDriver } from "../lib/llm-failover.js";
import { listUserModels, userEndpoint } from "../lib/provider-keys.js";
import { callerFetch } from "../lib/public-url.js";
import { semanticLookup, semanticStore } from "../lib/semantic-cache.js";
import { getUserDrivers } from "../lib/user-context.js";

import {
  getDefaultDriver,
  getFreeDriver,
  getPinnedDriver,
  PROVIDER_CATALOG_BASE,
} from "./api-bridge.js";

type Part = { type?: string; text?: string };
interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Part[] | null;
  tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
  tool_call_id?: string;
}
interface ChatBody {
  model?: unknown;
  messages?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: { type: string; function: { name: string; description?: string; parameters?: object } }[];
  tool_choice?: unknown;
}

const invalid = (reply: FastifyReply, message: string, status = 400) =>
  reply.code(status).send({ error: { message, type: "invalid_request_error", code: null } });

const text = (c: ChatMessage["content"]): string =>
  typeof c === "string"
    ? c
    : (c ?? []).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI's request as the driver contract: system turns become the system prompt. */
function toRequest(body: ChatBody, model: string): LlmRequestOptions {
  const all = body.messages as ChatMessage[];
  const system = all
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => text(m.content));
  const messages: LlmMessage[] = all
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => ({
      role: m.role as LlmMessage["role"],
      content: text(m.content),
      ...(m.tool_calls?.length
        ? {
            toolCalls: m.tool_calls.map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: parseArgs(c.function.arguments),
            })),
          }
        : {}),
      ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
    }));
  const tools: LlmToolDefinition[] | undefined = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: (t.function.parameters ?? { type: "object", properties: {} }) as Record<
      string,
      unknown
    >,
  }));
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  const choice = body.tool_choice;
  return {
    model,
    messages,
    ...(system.length ? { systemPrompt: system.join("\n\n") } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.stop !== undefined
      ? { stop: Array.isArray(body.stop) ? body.stop : [body.stop] }
      : {}),
    ...(tools?.length ? { tools } : {}),
    ...(choice === "auto" || choice === "none" || choice === "required"
      ? { toolChoice: choice }
      : {}),
  };
}

const toolCalls = (calls: LlmToolCall[]) =>
  calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));

const finish = (r: LlmResponse) =>
  r.toolCalls?.length ? "tool_calls" : r.finishReason === "length" ? "length" : "stop";

const usage = (r: LlmResponse) => ({
  prompt_tokens: r.usage.inputTokens,
  completion_tokens: r.usage.outputTokens,
  total_tokens: r.usage.inputTokens + r.usage.outputTokens,
});

const upstreamError = (err: unknown) => ({
  error: {
    message: err instanceof Error ? err.message : String(err),
    type: "upstream_error",
    code: null,
  },
});

async function complete(driver: FailoverDriver, opts: LlmRequestOptions, reply: FastifyReply) {
  const res = (await driver.complete(opts)) as LlmResponse & { servedBy?: string };
  if (res.servedBy) reply.header("x-nexus-served-by", res.servedBy);
  return res;
}

/**
 * The driver for a requested model, and the model id that driver should receive. "nexus/free"
 * routes across the caller's free models only; "auto" and "nexus/auto" use the whole chain.
 */
async function resolve(
  requested: string,
  userId: string | undefined,
): Promise<{ driver: FailoverDriver | undefined; model: string }> {
  if (requested === "nexus/free") {
    const driver = getFreeDriver(await listUserModels(userId).catch(() => []));
    return { driver, model: driver?.model ?? requested };
  }
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const pinned = getPinnedDriver(requested.slice(0, slash));
    if (pinned) return { driver: pinned, model: requested.slice(slash + 1) };
  }
  const chain = getDefaultDriver();
  return { driver: chain, model: chain?.model ?? requested };
}

export async function openaiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/models", async (request) => {
    const created = Math.floor(Date.now() / 1000);
    const ids = new Set<string>(["nexus/auto", "nexus/free"]);
    const named = new Map(
      (await listUserModels(request.nexusUserId).catch(() => [])).map((r) => [
        r.provider,
        r.models,
      ]),
    );
    for (const { id, driver } of getUserDrivers()) {
      const listed = named.get(id);
      for (const m of listed?.length ? listed : [driver.model]) ids.add(`${id}/${m}`);
    }
    // The server's own providers answer too; getDefaultDriver loads them into the snapshot.
    if (getDefaultDriver()) for (const p of getProviderSnapshot()) ids.add(`${p.id}/${p.model}`);
    return {
      object: "list",
      data: [...ids].map((id) => ({ id, object: "model", created, owned_by: id.split("/")[0] })),
    };
  });

  app.post<{ Body: ChatBody }>("/chat/completions", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.model !== "string" || !Array.isArray(body.messages) || !body.messages.length)
      return invalid(reply, "model and messages are required");
    const { driver, model } = await resolve(body.model, request.nexusUserId);
    if (!driver) return invalid(reply, "No provider key is saved for this account.", 404);
    const opts = toRequest(body, model);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!body.stream) {
      // Opt-in, and only for one plain question: context, instructions or tools change the answer.
      const lone = opts.messages.length === 1 && opts.messages[0]!.role === "user";
      const question =
        request.headers["x-nexus-semantic-cache"] === "on" &&
        lone &&
        !opts.systemPrompt &&
        !opts.tools?.length
          ? opts.messages[0]!.content
          : "";
      if (question) {
        const kept = await semanticLookup(request, question);
        reply.header("x-nexus-semantic-cache", kept.hit ? `hit ${kept.similarity}` : "miss");
        if (kept.hit)
          return {
            id,
            object: "chat.completion",
            created,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: kept.entry.response },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
      }
      try {
        const res = await complete(driver, opts, reply);
        if (question && res.content && !res.toolCalls?.length)
          await semanticStore(request, question, res.content);
        return {
          id,
          object: "chat.completion",
          created,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: res.content,
                ...(res.toolCalls?.length ? { tool_calls: toolCalls(res.toolCalls) } : {}),
              },
              finish_reason: finish(res),
            },
          ],
          usage: usage(res),
        };
      } catch (err) {
        return reply.code(502).send(upstreamError(err));
      }
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      raw.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    send({ role: "assistant", content: "" });
    try {
      const res = await driver.stream(opts, (d) => {
        if (d.delta) send({ content: d.delta });
      });
      send(res.toolCalls?.length ? { tool_calls: toolCalls(res.toolCalls) } : {}, finish(res));
    } catch (err) {
      raw.write(`data: ${JSON.stringify(upstreamError(err))}\n\n`);
    }
    raw.end("data: [DONE]\n\n");
  });

  app.post<{ Body: ChatBody & { prompt?: unknown } }>("/completions", async (request, reply) => {
    const body = request.body ?? {};
    const prompt = Array.isArray(body.prompt) ? body.prompt.join("") : body.prompt;
    if (typeof body.model !== "string" || typeof prompt !== "string")
      return invalid(reply, "model and prompt are required");
    const { driver, model } = await resolve(body.model, request.nexusUserId);
    if (!driver) return invalid(reply, "No provider key is saved for this account.", 404);
    try {
      const messages = [{ role: "user", content: prompt }];
      const res = await complete(driver, toRequest({ ...body, messages }, model), reply);
      return {
        id: `cmpl-${randomUUID()}`,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, text: res.content, finish_reason: finish(res), logprobs: null }],
        usage: usage(res),
      };
    } catch (err) {
      return reply.code(502).send(upstreamError(err));
    }
  });

  app.post<{ Body: { model?: unknown; input?: unknown } }>(
    "/embeddings",
    async (request, reply) => {
      const body = request.body ?? {};
      const slash = typeof body.model === "string" ? body.model.indexOf("/") : -1;
      if (slash <= 0 || body.input === undefined)
        return invalid(reply, "model (provider/model) and input are required");
      const requested = body.model as string;
      const provider = requested.slice(0, slash);
      const end = await userEndpoint(request.nexusUserId, provider, PROVIDER_CATALOG_BASE);
      if (!end) return invalid(reply, `No saved connection for provider "${provider}".`, 404);
      try {
        const res = await callerFetch(`${end.baseUrl.replace(/\/+$/, "")}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(end.key ? { authorization: `Bearer ${end.key}` } : {}),
          },
          body: JSON.stringify({ ...body, model: requested.slice(slash + 1) }),
        });
        const out = (await res.json()) as Record<string, unknown>;
        return reply.code(res.status).send(res.ok ? { ...out, model: requested } : out);
      } catch (err) {
        return reply.code(502).send(upstreamError(err));
      }
    },
  );
}
