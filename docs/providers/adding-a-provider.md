# Adding a provider

Most providers speak the same API: `POST /chat/completions`, `Authorization: Bearer <key>`,
the OpenAI request and response shapes. For those, a new provider is a five-line class, one
line in a factory, one row in a test table, one line in the settings list, and a paragraph
here. This page walks the whole path using **GitHub Models** as the worked example — a real
provider, added for real, whose entire implementation is the base URL and the default model.

If the provider needs something else — request signing, a non-OpenAI body, an access token
minted from a client id and secret — read [Providers that are not OpenAI-shaped](#providers-that-are-not-openai-shaped)
at the end. Do not put a bespoke driver into `OpenAICompatibleDriver` and hope.

---

## 1 — The driver

`packages/llm/src/drivers/index.ts`. Every provider file is single-file by design: one
`OpenAICompatibleDriver` base class, forty subclasses, no per-provider module to find.

```ts
export class GithubModelsDriver extends OpenAICompatibleDriver {
  readonly provider = "github_models";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl || "https://models.github.ai/inference";
    this.model = config.model ?? "openai/gpt-4.1-mini";
  }
}
```

What the base class gives you, and what you get for free by extending it:

| Behaviour                                   | Where it comes from                         |
| ------------------------------------------- | ------------------------------------------- |
| `Authorization: Bearer <key>`               | `OpenAICompatibleDriver.constructor`        |
| `systemPrompt` → a leading `system` message | `buildMessages`                             |
| tool definitions and tool-call parsing      | `toTools` / `fromToolCalls`                 |
| streaming, including partial tool arguments | `stream` + `toolCallDeltas`                 |
| `usage` → `{ inputTokens, outputTokens }`   | `parseUsage`                                |
| `countTokens`                               | `estimateTokens`, ~1 token per 4 characters |

Three rules that bite:

- **`config.model ?? "<default>"`, never `config.model || "<default>"`.** An explicit empty
  model means "the caller is about to set it", and `||` silently overrides them.
- **`config.baseUrl || "<default>"`, not `??`.** An empty string is a mistake, not a choice;
  falling back to the host is the behaviour that fails loudly instead of at request time.
- **Do not strip a trailing slash in the subclass** — the base class joins paths itself.
  (`CompatibleEndpointDriver` does strip one, because a user-typed URL arrives with one.)

Then add the name to the union so the compiler forces the rest of the wiring:

```ts
export type ProviderName =
  | "anthropic"
  | "groq"
  // …
  | "qwen"
  | "github_models"
  | "ai360";
```

## 2 — The factory

`apps/api/src/lib/provider-keys.ts` builds a driver per request from the user's stored key.
Import the class, add one entry:

```ts
github_models: (apiKey) => new GithubModelsDriver({ apiKey }),
```

`routes/provider-keys.ts` validates the provider name against `VALID_PROVIDERS` before
anything is stored, so add it there too — otherwise the key is refused with a 400 that names
no reason.

Composite credentials (endpoint + deployment and a key, or a client id and a secret) follow
the existing JSON-blob convention: the UI serialises the parts, the factory parses them with
`JSON.parse(key)` and the driver constructor's own type is the contract. `azure_openai`,
`bedrock`, `vertex`, `cloudflare`, `baidu_ernie` and `dify` are the six that do this; copy the
closest one rather than inventing a seventh shape.

## 3 — The adapter test

`packages/llm/tests/drivers/llm-drivers.test.ts` has one table for every OpenAI-compatible
provider. One row proves the three things that actually break: the provider name, the host,
and the auth header.

```ts
{
  name: "GithubModelsDriver",
  Factory: GithubModelsDriver,
  provider: "github_models",
  url: "models.github.ai/inference",
},
```

That row buys you, for free: `provider` is right, the request lands on
`/chat/completions`, the URL contains the host you named, the key is sent as a Bearer token,
content and usage parse, and the constructor accepts `{ apiKey }` alone. Run it:

```bash
pnpm --filter @nexus/llm test      # or: cd packages/llm && ../../node_modules/.bin/vp test run
```

A provider whose API is _openai-shaped but slightly not_ — a different tool-call field, a
`usage` object with other keys, an SSE format that needs a different parser — gets its own
`describe` block in the same file. Write the fake response from the vendor's documentation
and assert on the parse, not on the URL: the URL is already covered by the table.

## 4 — The settings list

`apps/ui/app/routes/provider-keys.tsx`, one row in `PROVIDERS`:

```ts
["github_models", "GitHub Models", "chat"],
```

The third field is `"chat"` or `"tool"`, and it decides which section of the page the
provider appears under. A chat provider with a free tier belongs in `FREE` as well, with the
URL where the key is issued — that list is what a new user reads first.

## 5 — This page, and the docs it points at

Add a `docs/providers/<name>.md` for anything a user has to do outside Nexus: where the key
comes from, what a model id looks like, which models are worth defaulting to, and the one
failure mode that is not obvious (a region, a quota, a required header). `lm-studio.md` is
the pattern.

Environment-variable defaults for a self-hosted deployment belong in `docs/DEPLOYMENT.md`,
not here — this page is about the code path a contributor follows.

---

## Providers that are not OpenAI-shaped

Three shapes exist beyond the base class, and each already has an example:

- **Different auth, same body** — `AnthropicDriver` (`x-api-key`, `anthropic-version`,
  `system` as a top-level field) and `GeminiDriver` (`?key=`, `contents[].parts[]`).
  Extend `BaseDriver`, implement `complete` and `stream`, and reuse `estimateTokens`.
- **Signed requests** — `BedrockDriver` (SigV4) and `VertexDriver` (GCP service-account
  token) extend `BaseDriver` and own their signing. Never put a signer in the compatible
  base class: it would run for forty providers that do not need it.
- **Not chat at all** — `ReplicateDriver` (predictions API), `BaiduErnieDriver` (access token
  exchange), `DifyDriver` (app-scoped, `/chat-messages`). These implement the same
  `LlmDriver` interface and nothing else.

For all three, the test writes the vendor's documented response into a `MockTransport`,
asserts the parsed content and usage, and asserts the one header or body field that the
provider differs on. `MockTransport` is exported from the drivers module for exactly this.

## Checklist

- [ ] driver class in `packages/llm/src/drivers/index.ts`
- [ ] name in the `ProviderName` union
- [ ] factory entry in `apps/api/src/lib/provider-keys.ts`
- [ ] name in `VALID_PROVIDERS` (`apps/api/src/routes/provider-keys.ts`)
- [ ] row in the compatible-provider table in `packages/llm/tests/drivers/llm-drivers.test.ts`
- [ ] row in `PROVIDERS` in `apps/ui/app/routes/provider-keys.tsx` (and `FREE` if it has one)
- [ ] `docs/providers/<name>.md` when the user has to do something outside Nexus
- [ ] `pnpm --filter @nexus/llm test`, `pnpm --filter @nexus/api build`, `pnpm verify:fast`
