---
id: sdk
title: SDK Reference
sidebar_position: 3
---

# @nexus/client — SDK Reference

`@nexus/client` is a typed, isomorphic fetch SDK for consuming the Nexus API from Node.js 18+ or browser environments.

## Installation

```bash
# Inside the Nexus monorepo
pnpm add @nexus/client

# From an external project (pin to a commit for stability)
pnpm add github:Yash-Awasthi/Nexus#main --filter @nexus/client
```

## Initialisation

```ts
import { NexusClient } from "@nexus/client";

const nexus = new NexusClient({
  baseUrl: "http://localhost:3000", // or your production URL
  apiKey: process.env.NEXUS_API_KEY,
  timeout: 30_000, // optional, default 30s
});
```

## Namespaces

### `gateway`

Direct LLM access via the Nexus model gateway.

```ts
// Single-turn chat
const res = await nexus.gateway.sendMessage({
  model: "nexus/smart", // or "anthropic/claude-3.5-sonnet", "openai/gpt-4o", etc.
  messages: [{ role: "user", content: "Explain monads" }],
  system: "Be concise.",
  temperature: 0.7,
});
console.log(res.content[0].text);

// Streaming (async generator — works in Node and browser)
for await (const event of nexus.gateway.sendMessageStream({
  model: "nexus/fast",
  messages: [{ role: "user", content: "Count to 10" }],
})) {
  if (event.type === "content_block_delta") {
    process.stdout.write(event.delta.text);
  }
}

// Race all models on a tier (ULTRAPLINIAN)
const race = await nexus.gateway.race({
  tier: "fast", // fast | standard | smart | power | ultra
  messages: [{ role: "user", content: "Best sorting algorithm?" }],
});
console.log(race.winner.model, race.winner.score, race.winner.content);

// List available models
const { models } = await nexus.gateway.listModels();

// Invoke a tool
const result = await nexus.gateway.invokeTool("web_search", { query: "TypeScript 5.6" });

// Get cost report
const report = await nexus.gateway.getCostReport();
```

### `council`

Multi-model deliberation via the council engine.

```ts
// Run a deliberation
const verdict = await nexus.council.deliberate({
  proposal: "Should we deploy version 2.0 to production?",
  context: "All tests passing. Zero critical bugs.",
  budget: 0.1, // max USD spend
});
console.log(verdict.result); // "approve" | "reject" | "defer"
console.log(verdict.confidence); // 0–1
console.log(verdict.reasoning); // synthesised reasoning

// List stored verdicts
const { verdicts } = await nexus.council.getVerdicts({ limit: 20, offset: 0 });

// Get a single verdict
const v = await nexus.council.getVerdict(verdictId);

// Get full council transcript
const { transcript } = await nexus.council.getTranscript(verdictId);

// Trigger deliberation on a signal
await nexus.council.trigger({ signalId: "sig_abc123" });
```

### `memory`

Agent long-term memory backed by pgvector.

```ts
// Store a memory
await nexus.memory.remember({
  content: "User prefers concise answers without preambles",
  category: "preference",
  tags: ["user", "style"],
  confidence: 0.9,
});

// Semantic recall
const { entries } = await nexus.memory.recall({
  query: "user communication preferences",
  limit: 5,
  category: "preference",
});

// Forget (delete by ID)
await nexus.memory.forget(entryId);

// List recent memories
const { entries: recent } = await nexus.memory.list({ limit: 50 });
```

### `agents`

File system and knowledge base access for agents.

```ts
// Query the knowledge librarian
const answer = await nexus.agents.queryLibrarian("How does the council voting work?");

// Read a file from agent workspace
const content = await nexus.agents.readFile("plans/roadmap.md");

// Write a file
await nexus.agents.writeFile("reports/summary.md", markdownContent);

// List files
const { files } = await nexus.agents.listFiles("reports/");
```

### `research`

Deep research and citation pipelines.

```ts
// Start a web research run
const run = await nexus.research.startResearch({
  query: "Latest developments in transformer architecture 2025",
  depth: 3,
  maxSources: 20,
});

// Start an academic search
const academic = await nexus.research.startAcademic({
  topic: "RAG retrieval augmented generation",
  yearFrom: 2023,
});

// Get citations for a research run
const { citations } = await nexus.research.getCitations(run.id);
```

## Error handling

All methods throw `NexusError` on non-2xx responses:

```ts
import { NexusClient, NexusError } from "@nexus/client";

try {
  await nexus.gateway.sendMessage({ ... });
} catch (err) {
  if (err instanceof NexusError) {
    console.error(err.code, err.statusCode, err.message);
  }
}
```

`NexusError` properties:

- `code` — machine-readable error code (e.g. `"UNAUTHORIZED"`, `"RATE_LIMITED"`)
- `statusCode` — HTTP status
- `message` — human-readable description
- `details` — raw error body from the API

## Timeout

Every request uses an `AbortController` internally. Pass `timeout` at construction or rely on the 30s default:

```ts
const nexus = new NexusClient({ baseUrl, apiKey, timeout: 60_000 });
```
