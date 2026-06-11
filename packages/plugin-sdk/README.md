<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/plugin-sdk

First-class adapter plugin SDK for NEXUS.

Provides everything needed to build, test, and register a new data source adapter without touching core. Adapters plug into `services/ingest` and emit typed events into the `ingested_events` pipeline.

## Installation

```bash
pnpm add @nexus/plugin-sdk   # in your adapter package
```

Or within the monorepo, declare a workspace dependency:

```json
{ "dependencies": { "@nexus/plugin-sdk": "workspace:*" } }
```

## Building an adapter

```ts
import { defineAdapter, requireEnv, withTimeout } from "@nexus/plugin-sdk";

export const githubAdapter = defineAdapter<GitHubWebhookPayload, NexusEvent>({
  id: "github",
  version: "1.0.0",
  capabilities: ["webhook", "auth:hmac", "streaming"],
  description: "GitHub webhook adapter — PRs, pushes, security alerts",

  // Called once on startup
  async setup(ctx) {
    const secret = requireEnv(ctx, "GITHUB_WEBHOOK_SECRET");
    return { secret };
  },

  // Called for each incoming event
  async execute(ctx, input) {
    return withTimeout(
      async () => ({
        source: "github",
        type: input.action === "security_alert" ? "security_alert" : "pull_request",
        payload: input,
        adapterVersion: "1.0.0",
      }),
      ctx,
      { timeoutMs: 5_000 },
    );
  },
});
```

## `defineAdapter(definition)`

| Field                 | Type                  | Description                                   |
| --------------------- | --------------------- | --------------------------------------------- |
| `id`                  | `string`              | Unique adapter identifier                     |
| `version`             | `string`              | Semver — used for compatibility checks        |
| `capabilities`        | `AdapterCapability[]` | Declared capabilities (see below)             |
| `description`         | `string`              | Human-readable description                    |
| `setup(ctx)`          | `async fn`            | One-time initialisation; return config object |
| `execute(ctx, input)` | `async fn`            | Per-event handler; return `NexusEvent`        |
| `teardown?(ctx)`      | `async fn`            | Optional cleanup on shutdown                  |

## `AdapterCapability`

```ts
type AdapterCapability =
  | "webhook"
  | "polling"
  | "streaming"
  | "auth:api-key"
  | "auth:oauth2"
  | "auth:hmac"
  | "pagination"
  | "rate-limited";
```

## `IExecutionContext`

Passed to every `setup` / `execute` / `teardown` call:

```ts
interface IExecutionContext {
  adapterId: string;
  logger: ILogger;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}
```

## Utilities

- **`requireEnv(ctx, key)`** — get a required env var or throw `AdapterConfigError`
- **`withTimeout(fn, ctx, opts)`** — wrap any async fn with a deadline; throws `AdapterTimeoutError` on expiry

## Error types

| Class                 | When thrown                                 |
| --------------------- | ------------------------------------------- |
| `NexusAdapterError`   | Base class for all adapter errors           |
| `AdapterTimeoutError` | `withTimeout` deadline exceeded             |
| `AdapterConfigError`  | Missing required config / env var           |
| `AdapterHttpError`    | Upstream HTTP error (includes `statusCode`) |

## `AdapterRegistry`

Used internally by `services/ingest` to discover and invoke registered adapters.

```ts
import { AdapterRegistry } from "@nexus/plugin-sdk";

const registry = new AdapterRegistry();
registry.register(githubAdapter);
registry.register(gmailAdapter);

const adapter = registry.get("github");
await adapter.execute(ctx, webhookPayload);
```

## Testing your adapter

`@nexus/plugin-sdk` exports a lightweight test harness:

```ts
import { createTestContext, MockAdapterRegistry } from "@nexus/plugin-sdk/testing";

const ctx = createTestContext({
  env: { GITHUB_WEBHOOK_SECRET: "test-secret" },
});

const result = await githubAdapter.execute(ctx, mockPayload);
expect(result.source).toBe("github");
```

## Full guide

See [`docs/plugin-author-guide.md`](../../docs/plugin-author-guide.md) for the complete walkthrough, including OAuth2 adapters, pagination patterns, rate limiting, and publishing to the adapter registry.
