<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/llm-drivers

Concrete HTTP adapters for 30+ LLM providers behind one provider-agnostic
interface ([`LlmDriver`](src/index.ts)):

```ts
interface LlmDriver {
  readonly provider: string;                 // stable id, e.g. "groq"
  readonly model: string;                    // default model id
  complete(opts: LlmRequestOptions): Promise<LlmResponse>;
  stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse>;
  countTokens(text: string): number;
}
```

Every driver handles auth-header injection, request-body shaping, response
parsing + token-usage extraction, real SSE/NDJSON streaming, and error mapping
to a typed [`LlmError`](src/index.ts) (`AUTH_FAILED`, `RATE_LIMITED`,
`CONTEXT_LENGTH_EXCEEDED`, …).

---

## Adding a new driver (no core edits needed)

The extension seams are public exports of this package — a new driver is a
standalone file that imports them:

| Export                       | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `OpenAICompatibleDriver`     | Implements `complete`/`stream` for OpenAI chat-completions-shaped endpoints. **Start here.** |
| `BaseDriver`                 | Real HTTP + SSE/NDJSON streaming, error mapping, response/usage helpers. For providers that  |
|                              | are NOT chat-completions-shaped (Anthropic, Gemini, Ollama extend this).                     |
| `HttpTransport`              | Injectable `post(url, body, headers)` — the only I/O a driver touches.                      |
| `MockTransport`              | Test transport: `setResponse()` / `setResponses()` + a `calls` log. No network in tests.     |
| `FullConfig` / `ApiKeyConfig` / `BaseUrlConfig` | Standard driver config: `apiKey` + optional `baseUrl` override.                 |
| `LlmRequestOptions` / `LlmResponse` / `StreamDelta` / `LlmToolCall` | The wire-neutral shapes every driver speaks.                   |

### Template — OpenAI-compatible provider (recommended)

```ts
// my-provider.ts — drop-in, zero core edits
// SPDX-License-Identifier: Apache-2.0
import {
  FullConfig,
  HttpTransport,
  OpenAICompatibleDriver,
} from "@nexus/llm-drivers";

export class MyProviderDriver extends OpenAICompatibleDriver {
  readonly provider = "myprovider";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.myprovider.com/v1";
    this.model = config.model ?? "my-flagship-model";
  }

  // Only needed when the endpoint or auth scheme deviates from the default
  // `{baseUrl}/chat/completions` + `Authorization: Bearer <apiKey>`:
  // protected override chatCompletionsUrl(): string { ... }
  // protected override authHeaders(): Record<string, string> { ... }
}
```

That is the whole driver: `complete`, `stream` (SSE), tool-calling, token
estimation, and `LlmError` mapping come from `OpenAICompatibleDriver`.

### Template — non-OpenAI provider

Extend `BaseDriver` and implement `complete()` (required) and, for streaming,
`stream()` using the protected `sseLines(url, body, headers)` /
`ndjsonLines(url, body, headers)` async generators. `makeResponse`,
`makeUsage`, and `countTokens` are provided. Mirror `AnthropicDriver` /
`GeminiDriver` / `OllamaDriver` in `src/index.ts` for reference.

### Testing recipe (mocked transport, no network)

```ts
// my-provider.test.ts
import { describe, expect, it } from "vitest";
import { MockTransport } from "@nexus/llm-drivers";
import { MyProviderDriver } from "./my-provider.js";

const transport = new MockTransport().setResponse({
  id: "chatcmpl-1",
  choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});

it("completes against the injected transport", async () => {
  const driver = new MyProviderDriver({ apiKey: "test" }, transport);
  const res = await driver.complete({ model: "my-flagship-model", messages: [] });
  expect(res.content).toBe("Hello!");
  expect(transport.calls[0]?.url).toBe("https://api.myprovider.com/v1/chat/completions");
  expect(transport.calls[0]?.headers).toMatchObject({ Authorization: "Bearer test" });
});
```

Key detail: when a transport is injected (`_useDefaultTransport = false`),
`stream()` falls back to a single-delta path driven by `complete()` — tests stay
simple. Real SSE/NDJSON streaming only activates with the default transport.

---

## Registering a driver

Drivers are plain classes — construct them wherever you resolve providers
(`apiKey` from env or BYOK registry). There is no global registry; consumers
build a map of `provider → driver factory`. Adding a provider therefore never
touches this package's `index.ts` again.