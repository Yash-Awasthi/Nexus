<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/shared

Shared types, Zod schemas, model registry, and error classes used across all NEXUS packages.

No business logic lives here — only primitives that multiple packages need without creating circular dependencies.

## Installation

Internal monorepo package. Imported by most other `@nexus/*` packages.

```ts
import { NexusError, Result, ok, err, ModelRegistry } from "@nexus/shared";
```

## Contents

### `Result<T, E>` — typed error handling

```ts
import { Result, ok, err } from "@nexus/shared";

function parse(raw: string): Result<Signal, NexusError> {
  try {
    return ok(JSON.parse(raw));
  } catch (e) {
    return err(new NexusError("PARSE_FAILED", String(e)));
  }
}

const result = parse(input);
if (result.ok) {
  use(result.value);
} else {
  log.error(result.error.code);
}
```

### `NexusError`

Base error class for all typed errors in NEXUS. Carry a `code` string and optional `cause`.

```ts
throw new NexusError("SIGNAL_NOT_FOUND", `Signal ${id} does not exist`);
```

### `ModelRegistry`

Central registry of available LLM model identifiers and their capability metadata (context window, supports tools, max output tokens).

```ts
import { ModelRegistry } from "@nexus/shared";

const model = ModelRegistry.get("llama-3.3-70b-versatile");
// { id, provider, contextWindow, supportsTools, maxOutputTokens }
```

### Shared Zod schemas

Common schemas shared between API contracts (`@nexus/contracts`) and runtime validation:

- `SignalSchema` — validates a `Signal` row
- `TaskSchema` — validates a `RuntimeTask`
- `VerdictSchema` — validates a council `Verdict`
- `PaginationSchema` — `{ page, limit, cursor }`
