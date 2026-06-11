<!-- SPDX-License-Identifier: Apache-2.0 -->
# @nexus/memory

Long-term agent memory with vector search for NEXUS.

Provides a swap-in architecture: develop with `FixedEmbedder` + `InMemoryStore` (no external dependencies), deploy with any real embedder + `PgVectorStore` backed by pgvector.

## Installation

Internal monorepo package. Consumed by `apps/worker` and `apps/api`.

```ts
import {
  MemoryManager,
  InMemoryStore,
  FixedEmbedder,
  type IEmbedder,
  type IMemoryStore,
} from "@nexus/memory";
```

## Quick start

```ts
const memory = new MemoryManager({
  store: new InMemoryStore(),
  embedder: new FixedEmbedder(128),  // swap for real embedder in production
  defaultRecallLimit: 5,
});

// Store a memory
const entry = await memory.remember("User prefers dark mode", {
  metadata: { agentId: "ui-agent", userId: "u-001" },
  ttl: 86400, // 24 hours
});

// Semantic recall
const results = await memory.recall("user interface preferences");
// results[0].entry.text, results[0].score (cosine similarity)

// Targeted recall with metadata filter
const agentMemories = await memory.recall("preferences", 10, {
  metadata: { agentId: "ui-agent" },
});

// Forget and purge
await memory.forget(entry.id);
await memory.purge({ metadata: { agentId: "ui-agent" } }); // returns count
```

## Interfaces

### `IEmbedder`

```ts
interface IEmbedder {
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
}
```

Implement this to swap in any embedding model (OpenAI `text-embedding-3-small`, local `nomic-embed-text`, etc.).

### `IMemoryStore`

```ts
interface IMemoryStore {
  save(entry: MemoryEntry): Promise<MemoryEntry>;
  search(queryEmbedding: number[], limit: number, filter?: MemoryFilter): Promise<MemorySearchResult[]>;
  delete(id: string): Promise<void>;
  list(filter?: MemoryFilter): Promise<MemoryEntry[]>;
  purge(filter?: MemoryFilter): Promise<number>;
}
```

### `MemoryFilter`

```ts
interface MemoryFilter {
  metadata?: Record<string, unknown>; // all keys must match
  excludeExpired?: boolean;           // default: true
}
```

## Included implementations

| Class | Use case |
|---|---|
| `FixedEmbedder` | Dev/test — deterministic pseudo-embedding, no API calls |
| `InMemoryStore` | Dev/test — exact cosine k-NN, O(n) per query |

For production, implement `IEmbedder` wrapping your model API and `IMemoryStore` wrapping Drizzle + pgvector's `<=>` operator.

## `MemoryManager` API

| Method | Description |
|---|---|
| `remember(text, options?)` | Embed and persist a memory |
| `recall(query, limit?, filter?)` | Semantic search — returns scored results |
| `forget(id)` | Remove by id |
| `list(filter?)` | List all active entries |
| `purge(filter?)` | Bulk delete by filter, returns count |
| `stats()` | `{ total, oldest, newest }` |

## Testing

```bash
pnpm --filter @nexus/memory test
```

28 tests: math helpers, FixedEmbedder determinism, InMemoryStore CRUD/filtering/TTL, MemoryManager full lifecycle including error propagation.
