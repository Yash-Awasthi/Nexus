// SPDX-License-Identifier: Apache-2.0
/**
 * llm-translate — convert LLM requests between provider API formats.
 *
 * Clients speak one vendor's API but you want to route to another. Rather than
 * N×N pairwise converters, this is
 * HUB-AND-SPOKE — every format normalizes to one canonical request, then
 * denormalizes to the target. Adding a provider is O(1) adapters, not O(N).
 *
 * Unlike the gateway's existing translator (which flattens content to a string
 * and drops tool calls), this preserves tool calls, tool results, and the
 * multi-turn structure — the parts that actually break agents when lost.
 *
 * Scope: request translation for the two formats that dominate, OpenAI Chat
 * Completions and Anthropic Messages. Response/stream translation already lives
 * in @nexus/gateway for the Anthropic-out path.
 * ponytail: ceiling is request-only + 2 formats. Upgrade path = add a spoke
 * (Gemini `contents[]`) and a response normalizer; the hub stays unchanged.
 */

// ── Canonical (hub) form ─────────────────────────────────────────────────────────

export type CanonicalRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalToolCall {
  id: string;
  name: string;
  /** Parsed arguments object (NOT a JSON string — normalized on the way in). */
  arguments: Record<string, unknown>;
}

export interface CanonicalMessage {
  role: CanonicalRole;
  /** Plain text content. Empty string when a turn is purely tool calls. */
  content: string;
  /** Present on assistant turns that call tools. */
  toolCalls?: CanonicalToolCall[];
  /** Present on `tool` messages: which call this is the result of. */
  toolCallId?: string;
}

export interface CanonicalTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface CanonicalRequest {
  model?: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export type Format = "openai" | "anthropic" | "gemini" | "vertex" | "responses" | "ollama";

// ── Loose provider shapes (input/output) ─────────────────────────────────────────
// Typed loosely on purpose: callers pass parsed JSON from arbitrary clients. We
// read the fields we understand and ignore the rest.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ── OpenAI Chat Completions ⇄ canonical ──────────────────────────────────────────

function fromOpenAI(req: Json): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  for (const raw of Array.isArray(req.messages) ? req.messages : []) {
    const m = obj(raw);
    const role = str(m.role) as CanonicalRole;
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc) => {
          const c = obj(tc);
          const fn = obj(c.function);
          let args: Record<string, unknown> = {};
          try {
            args = fn.arguments ? (JSON.parse(str(fn.arguments)) as Record<string, unknown>) : {};
          } catch {
            args = {}; // malformed args from the wire → empty, never throw
          }
          return { id: str(c.id), name: str(fn.name), arguments: args };
        })
      : undefined;
    messages.push({
      role,
      content: str(m.content),
      ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
      ...(m.tool_call_id !== undefined && { toolCallId: str(m.tool_call_id) }),
    });
  }
  const tools = Array.isArray(req.tools)
    ? req.tools.map((t) => {
        const fn = obj(obj(t).function);
        return {
          name: str(fn.name),
          description: fn.description ? str(fn.description) : undefined,
          parameters: obj(fn.parameters),
        };
      })
    : undefined;
  return {
    model: req.model ? str(req.model) : undefined,
    messages,
    ...(tools && { tools }),
    ...(typeof req.max_tokens === "number" && { maxTokens: req.max_tokens }),
    ...(typeof req.temperature === "number" && { temperature: req.temperature }),
    ...(req.stream === true && { stream: true }),
  };
}

function toOpenAI(req: CanonicalRequest): Json {
  const messages = req.messages.map((m) => {
    const out: Json = { role: m.role, content: m.content };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    if (m.toolCallId !== undefined) out.tool_call_id = m.toolCallId;
    return out;
  });
  const out: Json = { messages };
  if (req.model) out.model = req.model;
  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
        parameters: t.parameters,
      },
    }));
  }
  if (req.maxTokens !== undefined) out.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.stream) out.stream = true;
  return out;
}

// ── Anthropic Messages ⇄ canonical ───────────────────────────────────────────────
// Anthropic differs structurally: `system` is top-level (not a message), content
// is a block array, tool calls are `tool_use` blocks on assistant turns, and tool
// RESULTS ride inside USER turns as `tool_result` blocks. Normalizing pulls those
// apart into flat canonical messages; denormalizing regroups them.

function fromAnthropic(req: Json): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  if (req.system) messages.push({ role: "system", content: str(req.system) });

  for (const raw of Array.isArray(req.messages) ? req.messages : []) {
    const m = obj(raw);
    const role = str(m.role);
    const content = m.content;

    if (typeof content === "string") {
      messages.push({ role: role as CanonicalRole, content });
      continue;
    }
    const blocks = Array.isArray(content) ? content.map(obj) : [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => str(b.text))
      .join("\n");
    const toolUse = blocks.filter((b) => b.type === "tool_use");
    const toolResults = blocks.filter((b) => b.type === "tool_result");

    // tool_result blocks (carried in a user turn) become flat `tool` messages.
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: typeof tr.content === "string" ? tr.content : flattenBlocks(tr.content),
        toolCallId: str(tr.tool_use_id),
      });
    }
    if (toolResults.length > 0 && toolUse.length === 0 && text === "") continue;

    messages.push({
      role: role as CanonicalRole,
      content: text,
      ...(toolUse.length > 0 && {
        toolCalls: toolUse.map((b) => ({
          id: str(b.id),
          name: str(b.name),
          arguments: obj(b.input),
        })),
      }),
    });
  }

  const tools = Array.isArray(req.tools)
    ? req.tools.map((t) => {
        const tt = obj(t);
        return {
          name: str(tt.name),
          description: tt.description ? str(tt.description) : undefined,
          parameters: obj(tt.input_schema),
        };
      })
    : undefined;

  return {
    model: req.model ? str(req.model) : undefined,
    messages,
    ...(tools && { tools }),
    ...(typeof req.max_tokens === "number" && { maxTokens: req.max_tokens }),
    ...(typeof req.temperature === "number" && { temperature: req.temperature }),
    ...(req.stream === true && { stream: true }),
  };
}

/** Anthropic tool_result content can itself be a block array; flatten to text. */
function flattenBlocks(content: unknown): string {
  if (!Array.isArray(content)) return str(content);
  return content
    .map(obj)
    .filter((b) => b.type === "text")
    .map((b) => str(b.text))
    .join("\n");
}

function toAnthropic(req: CanonicalRequest): Json {
  let system: string | undefined;
  const messages: Json[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      system = system ? `${system}\n${m.content}` : m.content;
      continue;
    }
    if (m.role === "tool") {
      // Tool results must live in a USER turn. Merge into the previous one if it
      // is already a user turn holding tool_results; else open a new user turn.
      const block: Json = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as Json[]).push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
      continue;
    }
    // user / assistant
    const blocks: Json[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
    }
    messages.push({ role: m.role, content: blocks });
  }

  const out: Json = { messages };
  if (req.model) out.model = req.model;
  if (system !== undefined) out.system = system;
  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      input_schema: t.parameters,
    }));
  }
  // Anthropic requires max_tokens; default when the source format omitted it.
  out.max_tokens = req.maxTokens ?? 4096;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.stream) out.stream = true;
  return out;
}

// ── Gemini `contents[]` ⇄ canonical ──────────────────────────────────────────────
// Gemini uses roles "user"/"model" (no "assistant"/"system"), a top-level
// `systemInstruction`, and `parts[]` per turn holding `text` / `functionCall` /
// `functionResponse`. Unlike OpenAI/Anthropic, Gemini has no per-call id — calls
// and their responses match by `name` alone — so we use the function name as the
// canonical `toolCallId`/`id` too.

function fromGemini(req: Json): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  const sys = obj(req.systemInstruction);
  const sysParts = Array.isArray(sys.parts) ? sys.parts.map(obj) : [];
  const sysText = sysParts
    .map((p) => str(p.text))
    .filter(Boolean)
    .join("\n");
  if (sysText) messages.push({ role: "system", content: sysText });

  for (const raw of Array.isArray(req.contents) ? req.contents : []) {
    const c = obj(raw);
    const role = str(c.role) === "model" ? "assistant" : "user";
    const parts = Array.isArray(c.parts) ? c.parts.map(obj) : [];

    const text = parts
      .map((p) => str(p.text))
      .filter(Boolean)
      .join("\n");
    const calls = parts.filter((p) => p.functionCall);
    const responses = parts.filter((p) => p.functionResponse);

    for (const p of responses) {
      const fr = obj(p.functionResponse);
      const response = obj(fr.response);
      messages.push({
        role: "tool",
        content: typeof response.content === "string" ? response.content : JSON.stringify(response),
        toolCallId: str(fr.name),
      });
    }
    if (responses.length > 0 && calls.length === 0 && text === "") continue;

    messages.push({
      role,
      content: text,
      ...(calls.length > 0 && {
        toolCalls: calls.map((p) => {
          const fc = obj(p.functionCall);
          return { id: str(fc.name), name: str(fc.name), arguments: obj(fc.args) };
        }),
      }),
    });
  }

  const tools = Array.isArray(req.tools)
    ? Array.isArray(obj(req.tools[0]).functionDeclarations)
      ? (obj(req.tools[0]).functionDeclarations as unknown[]).map((t) => {
          const tt = obj(t);
          return {
            name: str(tt.name),
            description: tt.description ? str(tt.description) : undefined,
            parameters: obj(tt.parameters),
          };
        })
      : undefined
    : undefined;

  const gen = obj(req.generationConfig);
  return {
    model: req.model ? str(req.model) : undefined,
    messages,
    ...(tools && { tools }),
    ...(typeof gen.maxOutputTokens === "number" && { maxTokens: gen.maxOutputTokens }),
    ...(typeof gen.temperature === "number" && { temperature: gen.temperature }),
    ...(req.stream === true && { stream: true }),
  };
}

function toGemini(req: CanonicalRequest): Json {
  let systemInstruction: Json | undefined;
  const contents: Json[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      const prevText = systemInstruction
        ? str(obj((systemInstruction.parts as Json[])[0]).text)
        : "";
      systemInstruction = { parts: [{ text: prevText ? `${prevText}\n${m.content}` : m.content }] };
      continue;
    }
    if (m.role === "tool") {
      const part: Json = {
        functionResponse: { name: m.toolCallId ?? "", response: { content: m.content } },
      };
      const prev = contents[contents.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.parts)) {
        (prev.parts as Json[]).push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }
    const parts: Json[] = [];
    if (m.content) parts.push({ text: m.content });
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }

  const out: Json = { contents };
  if (req.model) out.model = req.model;
  if (systemInstruction) out.systemInstruction = systemInstruction;
  if (req.tools) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description !== undefined && { description: t.description }),
          parameters: t.parameters,
        })),
      },
    ];
  }
  if (req.maxTokens !== undefined || req.temperature !== undefined) {
    out.generationConfig = {
      ...(req.maxTokens !== undefined && { maxOutputTokens: req.maxTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    };
  }
  if (req.stream) out.stream = true;
  return out;
}

// ── Vertex AI (Gemini) ⇄ canonical ───────────────────────────────────────────────
// Vertex serves the *same* Gemini payload (contents/systemInstruction/tools/
// generationConfig), but the model and streaming mode are URL-bound rather than
// body fields: the request hits
// `.../models/{model}:generateContent` vs `:streamGenerateContent`, so neither
// `model` nor `stream` belongs in the body. The spokes are therefore thin wrappers
// around the Gemini pair — read via the same parser, then strip the URL-bound keys.

function fromVertex(req: Json): CanonicalRequest {
  // Vertex bodies never carry `model`/`stream`; fromGemini already tolerates their
  // absence, so it parses the shared payload as-is.
  return fromGemini(req);
}

function toVertex(req: CanonicalRequest): Json {
  const out = toGemini(req);
  delete out.model; // model rides in the URL path segment
  delete out.stream; // streaming is selected by the `:streamGenerateContent` verb
  return out;
}

// ── OpenAI Responses API ⇄ canonical ─────────────────────────────────────────────
// The Responses API is structurally distinct from Chat Completions: `messages`
// becomes a flat `input[]` of items, the system prompt lifts to a top-level
// `instructions` string, and tool calls / results are their OWN items
// (`function_call` / `function_call_output`) rather than fields on a message. Tools
// are flat (`{type,name,description,parameters}`, no nested `function`), and the
// token cap is `max_output_tokens`. Content can be a plain string or typed parts
// (`input_text` / `output_text`).

/** Extract plain text from a Responses content field (string or typed parts). */
function responsesText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(obj)
    .map((p) => str(p.text))
    .filter(Boolean)
    .join("\n");
}

function fromResponses(req: Json): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  if (req.instructions) messages.push({ role: "system", content: str(req.instructions) });

  const input = req.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
  } else {
    for (const raw of Array.isArray(input) ? input : []) {
      const item = obj(raw);
      const type = str(item.type);
      if (type === "function_call") {
        let args: Record<string, unknown> = {};
        try {
          args = item.arguments ? (JSON.parse(str(item.arguments)) as Record<string, unknown>) : {};
        } catch {
          args = {}; // malformed args from the wire → empty, never throw
        }
        const call = { id: str(item.call_id), name: str(item.name), arguments: args };
        const prev = messages[messages.length - 1];
        if (prev && prev.role === "assistant") {
          prev.toolCalls = [...(prev.toolCalls ?? []), call];
        } else {
          messages.push({ role: "assistant", content: "", toolCalls: [call] });
        }
        continue;
      }
      if (type === "function_call_output") {
        messages.push({
          role: "tool",
          content: responsesText(item.output),
          toolCallId: str(item.call_id),
        });
        continue;
      }
      // message item (type "message" or bare role): user/assistant text.
      const role = str(item.role) as CanonicalRole;
      messages.push({ role, content: responsesText(item.content) });
    }
  }

  const tools = Array.isArray(req.tools)
    ? req.tools.map((t) => {
        const tt = obj(t);
        return {
          name: str(tt.name),
          description: tt.description ? str(tt.description) : undefined,
          parameters: obj(tt.parameters),
        };
      })
    : undefined;

  return {
    model: req.model ? str(req.model) : undefined,
    messages,
    ...(tools && { tools }),
    ...(typeof req.max_output_tokens === "number" && { maxTokens: req.max_output_tokens }),
    ...(typeof req.temperature === "number" && { temperature: req.temperature }),
    ...(req.stream === true && { stream: true }),
  };
}

function toResponses(req: CanonicalRequest): Json {
  let instructions: string | undefined;
  const input: Json[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      instructions = instructions ? `${instructions}\n${m.content}` : m.content;
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "",
        output: m.content,
      });
      continue;
    }
    // user / assistant: text becomes a message item; tool calls become their own
    // function_call items (an assistant turn can be pure tool calls → no message).
    if (m.content) input.push({ role: m.role, content: m.content });
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        });
      }
    }
  }

  const out: Json = { input };
  if (req.model) out.model = req.model;
  if (instructions !== undefined) out.instructions = instructions;
  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      parameters: t.parameters,
    }));
  }
  if (req.maxTokens !== undefined) out.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.stream) out.stream = true;
  return out;
}

// ── Ollama `/api/chat` ⇄ canonical ───────────────────────────────────────────────
// Ollama's chat API resembles OpenAI Chat Completions (a `messages[]` with
// system/user/assistant/tool roles and OpenAI-shaped `tools`), but three things
// differ: tool-call `arguments` are a JSON OBJECT (not a stringified string); tool
// calls carry no `id` and results reference the call by `tool_name` (not
// `tool_call_id`) — so, like Gemini, we key by name; and sampling params live under
// an `options` object (`num_predict` = max tokens, `temperature`), not top-level.

function fromOllama(req: Json): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  for (const raw of Array.isArray(req.messages) ? req.messages : []) {
    const m = obj(raw);
    const role = str(m.role) as CanonicalRole;
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc) => {
          const fn = obj(obj(tc).function);
          // Ollama arguments are already an object — no JSON.parse, never throws.
          return { id: str(fn.name), name: str(fn.name), arguments: obj(fn.arguments) };
        })
      : undefined;
    messages.push({
      role,
      content: str(m.content),
      ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
      ...(m.tool_name !== undefined && { toolCallId: str(m.tool_name) }),
    });
  }

  const tools = Array.isArray(req.tools)
    ? req.tools.map((t) => {
        const fn = obj(obj(t).function);
        return {
          name: str(fn.name),
          description: fn.description ? str(fn.description) : undefined,
          parameters: obj(fn.parameters),
        };
      })
    : undefined;

  const options = obj(req.options);
  return {
    model: req.model ? str(req.model) : undefined,
    messages,
    ...(tools && { tools }),
    ...(typeof options.num_predict === "number" && { maxTokens: options.num_predict }),
    ...(typeof options.temperature === "number" && { temperature: options.temperature }),
    ...(req.stream === true && { stream: true }),
  };
}

function toOllama(req: CanonicalRequest): Json {
  const messages = req.messages.map((m) => {
    const out: Json = { role: m.role, content: m.content };
    if (m.toolCalls?.length) {
      // Ollama keeps args as an object and carries no call id.
      out.tool_calls = m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    // Tool results reference their call by name via `tool_name`.
    if (m.role === "tool" && m.toolCallId !== undefined) out.tool_name = m.toolCallId;
    return out;
  });

  const out: Json = { messages };
  if (req.model) out.model = req.model;
  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
        parameters: t.parameters,
      },
    }));
  }
  const options: Json = {};
  if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (Object.keys(options).length > 0) out.options = options;
  if (req.stream) out.stream = true;
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────────

const NORMALIZERS: Record<Format, (req: Json) => CanonicalRequest> = {
  openai: fromOpenAI,
  anthropic: fromAnthropic,
  gemini: fromGemini,
  vertex: fromVertex,
  responses: fromResponses,
  ollama: fromOllama,
};
const DENORMALIZERS: Record<Format, (req: CanonicalRequest) => Json> = {
  openai: toOpenAI,
  anthropic: toAnthropic,
  gemini: toGemini,
  vertex: toVertex,
  responses: toResponses,
  ollama: toOllama,
};

/** Parse a provider request into the canonical hub form. */
export function normalize(req: unknown, from: Format): CanonicalRequest {
  return NORMALIZERS[from](obj(req));
}

/** Render a canonical request into a provider format. */
export function denormalize(req: CanonicalRequest, to: Format): Json {
  return DENORMALIZERS[to](req);
}

/** Translate a request from one provider format to another (any↔any via the hub). */
export function translate(req: unknown, from: Format, to: Format): Json {
  return denormalize(normalize(req, from), to);
}

// ── Streaming (response chunk translation) ───────────────────────────────────────
// Same hub-and-spoke idea, one level down: a provider's SSE chunk normalizes to a
// flat list of CanonicalStreamEvents, then an emitter renders them into the target
// provider's chunk shape. Callers own SSE line framing / `data: [DONE]` sentinels /
// `event:` names — this layer works on already-decoded chunk objects.
//
// Parsing is defined for every Format; emitting is defined for the two formats the
// gateway actually transcodes between (openai ⇄ anthropic — the dominant pair, and
// the one §2.4 wires). Emitting to a parse-only format throws a clear error rather
// than silently dropping deltas.

export type CanonicalStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | { type: "finish"; reason?: string };

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

// ── Chunk parsers (provider chunk → canonical events) ─────────────────────────────

function chunkFromOpenAI(d: Json): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  for (const rawChoice of Array.isArray(d.choices) ? d.choices : []) {
    const choice = obj(rawChoice);
    const delta = obj(choice.delta);
    if (delta.content) events.push({ type: "text", text: str(delta.content) });
    // Some OpenAI-compatible providers stream reasoning as `reasoning_content`.
    if (delta.reasoning_content)
      events.push({ type: "thinking", text: str(delta.reasoning_content) });
    for (const rawTc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const tc = obj(rawTc);
      const index = num(tc.index);
      const fn = obj(tc.function);
      // The opening chunk carries id+name; later chunks carry only arg fragments.
      if (tc.id || fn.name) {
        events.push({ type: "tool_call_start", index, id: str(tc.id), name: str(fn.name) });
      }
      if (fn.arguments) events.push({ type: "tool_call_args", index, delta: str(fn.arguments) });
    }
    if (choice.finish_reason) events.push({ type: "finish", reason: str(choice.finish_reason) });
  }
  return events;
}

function chunkFromAnthropic(d: Json): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  const type = str(d.type);
  if (type === "content_block_start") {
    const cb = obj(d.content_block);
    if (str(cb.type) === "tool_use") {
      events.push({
        type: "tool_call_start",
        index: num(d.index),
        id: str(cb.id),
        name: str(cb.name),
      });
    }
  } else if (type === "content_block_delta") {
    const delta = obj(d.delta);
    const dt = str(delta.type);
    if (dt === "text_delta") events.push({ type: "text", text: str(delta.text) });
    else if (dt === "input_json_delta")
      events.push({ type: "tool_call_args", index: num(d.index), delta: str(delta.partial_json) });
    else if (dt === "thinking_delta") events.push({ type: "thinking", text: str(delta.thinking) });
  } else if (type === "message_delta") {
    const delta = obj(d.delta);
    if (delta.stop_reason) events.push({ type: "finish", reason: str(delta.stop_reason) });
  }
  return events;
}

/** Gemini/Vertex stream: full `functionCall.args` arrive at once (no partial JSON). */
function chunkFromGemini(d: Json): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  for (const rawCand of Array.isArray(d.candidates) ? d.candidates : []) {
    const cand = obj(rawCand);
    const parts = Array.isArray(obj(cand.content).parts)
      ? (obj(cand.content).parts as unknown[])
      : [];
    let toolIndex = 0;
    for (const rawPart of parts) {
      const p = obj(rawPart);
      if (p.text) events.push({ type: "text", text: str(p.text) });
      if (p.functionCall) {
        const fc = obj(p.functionCall);
        const idx = toolIndex++;
        events.push({ type: "tool_call_start", index: idx, id: str(fc.name), name: str(fc.name) });
        events.push({ type: "tool_call_args", index: idx, delta: JSON.stringify(obj(fc.args)) });
      }
    }
    if (cand.finishReason) events.push({ type: "finish", reason: str(cand.finishReason) });
  }
  return events;
}

/** Ollama `/api/chat` stream: content deltas + whole-object tool_calls; `done` ends. */
function chunkFromOllama(d: Json): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  const m = obj(d.message);
  if (m.content) events.push({ type: "text", text: str(m.content) });
  let toolIndex = 0;
  for (const rawTc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    const fn = obj(obj(rawTc).function);
    const idx = toolIndex++;
    events.push({ type: "tool_call_start", index: idx, id: str(fn.name), name: str(fn.name) });
    events.push({ type: "tool_call_args", index: idx, delta: JSON.stringify(obj(fn.arguments)) });
  }
  if (d.done === true)
    events.push({ type: "finish", reason: d.done_reason ? str(d.done_reason) : "stop" });
  return events;
}

/** OpenAI Responses stream: typed `response.*` events carry text/arg deltas. */
function chunkFromResponses(d: Json): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  const type = str(d.type);
  if (type === "response.output_text.delta") events.push({ type: "text", text: str(d.delta) });
  else if (type === "response.reasoning_summary_text.delta")
    events.push({ type: "thinking", text: str(d.delta) });
  else if (type === "response.output_item.added") {
    const item = obj(d.item);
    if (str(item.type) === "function_call") {
      events.push({
        type: "tool_call_start",
        index: num(d.output_index),
        id: str(item.call_id),
        name: str(item.name),
      });
    }
  } else if (type === "response.function_call_arguments.delta") {
    events.push({ type: "tool_call_args", index: num(d.output_index), delta: str(d.delta) });
  } else if (type === "response.completed") {
    events.push({ type: "finish", reason: "stop" });
  }
  return events;
}

const CHUNK_NORMALIZERS: Record<Format, (d: Json) => CanonicalStreamEvent[]> = {
  openai: chunkFromOpenAI,
  anthropic: chunkFromAnthropic,
  gemini: chunkFromGemini,
  vertex: chunkFromGemini, // identical stream shape to gemini
  responses: chunkFromResponses,
  ollama: chunkFromOllama,
};

/** Parse one decoded provider stream chunk into canonical events. */
export function normalizeStreamChunk(chunk: unknown, from: Format): CanonicalStreamEvent[] {
  return CHUNK_NORMALIZERS[from](obj(chunk));
}

// ── Chunk emitters (canonical events → provider chunk objects) ────────────────────
// Emitters are stateful (a stream is a sequence): the OpenAI emitter is near-flat,
// the Anthropic emitter tracks open content blocks so it can bracket text/tool_use
// blocks with the start/stop events Anthropic requires.

/** Map a canonical/OpenAI finish reason onto an Anthropic stop_reason. */
function mapStopReasonToAnthropic(reason: string | undefined): string {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/** Map an Anthropic stop_reason onto an OpenAI finish_reason. */
function mapStopReasonToOpenAI(reason: string | undefined): string {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export interface StreamEmitter {
  emit(events: CanonicalStreamEvent[]): Json[];
  /** Closing frames when the source stream ends without an explicit finish event. */
  flush(): Json[];
}

class OpenAIStreamEmitter implements StreamEmitter {
  emit(events: CanonicalStreamEvent[]): Json[] {
    return events.map((e) => {
      switch (e.type) {
        case "text":
          return { choices: [{ index: 0, delta: { content: e.text }, finish_reason: null }] };
        case "thinking":
          return {
            choices: [{ index: 0, delta: { reasoning_content: e.text }, finish_reason: null }],
          };
        case "tool_call_start":
          return {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: e.index,
                      id: e.id,
                      type: "function",
                      function: { name: e.name, arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        case "tool_call_args":
          return {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: e.index, function: { arguments: e.delta } }] },
                finish_reason: null,
              },
            ],
          };
        case "finish":
          return {
            choices: [{ index: 0, delta: {}, finish_reason: mapStopReasonToOpenAI(e.reason) }],
          };
      }
    });
  }
  flush(): Json[] {
    return [];
  }
}

class AnthropicStreamEmitter implements StreamEmitter {
  private started = false;
  private nextIndex = 0;
  private textOpen = false;
  private textIndex = -1;
  private finished = false;
  private readonly toolBlocks = new Map<number, number>();

  private open(out: Json[]): void {
    if (!this.started) {
      out.push({ type: "message_start", message: { role: "assistant", content: [] } });
      this.started = true;
    }
  }

  private closeOpenBlocks(out: Json[]): void {
    if (this.textOpen) {
      out.push({ type: "content_block_stop", index: this.textIndex });
      this.textOpen = false;
    }
    for (const blockIndex of this.toolBlocks.values()) {
      out.push({ type: "content_block_stop", index: blockIndex });
    }
    this.toolBlocks.clear();
  }

  emit(events: CanonicalStreamEvent[]): Json[] {
    const out: Json[] = [];
    for (const e of events) {
      this.open(out);
      switch (e.type) {
        case "text":
          if (!this.textOpen) {
            this.textIndex = this.nextIndex++;
            out.push({
              type: "content_block_start",
              index: this.textIndex,
              content_block: { type: "text", text: "" },
            });
            this.textOpen = true;
          }
          out.push({
            type: "content_block_delta",
            index: this.textIndex,
            delta: { type: "text_delta", text: e.text },
          });
          break;
        case "thinking":
          if (!this.textOpen) {
            this.textIndex = this.nextIndex++;
            out.push({
              type: "content_block_start",
              index: this.textIndex,
              content_block: { type: "thinking", thinking: "" },
            });
            this.textOpen = true;
          }
          out.push({
            type: "content_block_delta",
            index: this.textIndex,
            delta: { type: "thinking_delta", thinking: e.text },
          });
          break;
        case "tool_call_start": {
          // A tool block cannot share the open text block — close it first.
          if (this.textOpen) {
            out.push({ type: "content_block_stop", index: this.textIndex });
            this.textOpen = false;
          }
          const blockIndex = this.nextIndex++;
          this.toolBlocks.set(e.index, blockIndex);
          out.push({
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: e.id, name: e.name, input: {} },
          });
          break;
        }
        case "tool_call_args": {
          const blockIndex = this.toolBlocks.get(e.index) ?? 0;
          out.push({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: e.delta },
          });
          break;
        }
        case "finish":
          this.closeOpenBlocks(out);
          out.push({
            type: "message_delta",
            delta: { stop_reason: mapStopReasonToAnthropic(e.reason) },
          });
          out.push({ type: "message_stop" });
          this.finished = true;
          break;
      }
    }
    return out;
  }

  flush(): Json[] {
    if (!this.started || this.finished) return [];
    const out: Json[] = [];
    this.closeOpenBlocks(out);
    out.push({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    out.push({ type: "message_stop" });
    this.finished = true;
    return out;
  }
}

const STREAM_EMITTERS: Partial<Record<Format, () => StreamEmitter>> = {
  openai: () => new OpenAIStreamEmitter(),
  anthropic: () => new AnthropicStreamEmitter(),
};

/**
 * Stateful streaming transcoder. Feed decoded source chunks via `translateChunk`;
 * it returns zero or more decoded target chunks. Call `flush()` once the source
 * stream ends to emit any closing frames the target format requires.
 */
export class StreamTranslator {
  private readonly parse: (d: Json) => CanonicalStreamEvent[];
  private readonly emitter: StreamEmitter;

  constructor(from: Format, to: Format) {
    const makeEmitter = STREAM_EMITTERS[to];
    if (!makeEmitter) {
      throw new Error(`llm-translate: streaming emit not supported for format "${to}"`);
    }
    this.parse = CHUNK_NORMALIZERS[from];
    this.emitter = makeEmitter();
  }

  /** Translate one decoded source chunk into zero or more decoded target chunks. */
  translateChunk(chunk: unknown): Json[] {
    return this.emitter.emit(this.parse(obj(chunk)));
  }

  /** Emit closing frames after the source stream ends. */
  flush(): Json[] {
    return this.emitter.flush();
  }
}
