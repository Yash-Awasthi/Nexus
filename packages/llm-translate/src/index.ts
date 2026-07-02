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

export type Format = "openai" | "anthropic" | "gemini";

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

// ── Public API ────────────────────────────────────────────────────────────────────

const NORMALIZERS: Record<Format, (req: Json) => CanonicalRequest> = {
  openai: fromOpenAI,
  anthropic: fromAnthropic,
  gemini: fromGemini,
};
const DENORMALIZERS: Record<Format, (req: CanonicalRequest) => Json> = {
  openai: toOpenAI,
  anthropic: toAnthropic,
  gemini: toGemini,
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
