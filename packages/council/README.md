<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/council

Multi-model deliberation engine for NEXUS (evolved from Judica).

Orchestrates parallel queries to multiple LLM providers, synthesises their responses using configurable voting modes, and enforces guardrail constraints on the output.

## Installation

Internal monorepo package. Consumed by `apps/api`, `apps/worker`, and `@nexus/runtime` via `CouncilBridge`.

```ts
import { CouncilService, DeliberationEngine, summonArchetypes } from "@nexus/council";
```

## Architecture

```
CouncilService
  └─▶ DeliberationEngine
        ├─▶ ILLMTransport × N  (Groq, OpenAI, …)
        ├─▶ Archetype presets   (deliberative, analytical, creative, …)
        └─▶ Synthesis + guardrails
```

## Quick start

```ts
import { CouncilService } from "@nexus/council";
import { GroqTransport } from "@nexus/council";

const council = new CouncilService({
  transports: [new GroqTransport({ apiKey: process.env.GROQ_API_KEY })],
  votingMode: "majority",   // "unanimous" | "majority" | "weighted"
  synthesisModel: "llama-3.3-70b-versatile",
});

const result = await council.deliberate({
  question: "Should we approve this deployment?",
  context: { signals: [...], taskGraph: {...} },
  archetypes: summonArchetypes(["deliberative", "risk-analyst"]),
});

// result.verdict: "approve" | "reject" | "defer"
// result.reasoning: string
// result.transcript: CouncilTranscript[]
// result.confidence: number
```

## Components

### `DeliberationEngine`

Core engine. Takes an `ILLMTransport[]`, sends the same prompt to each, collects `ILLMResponse[]`, and runs synthesis.

```ts
const engine = new DeliberationEngine({
  transports: [...],
  votingMode: "majority",
  maxRetries: 2,
  timeoutMs: 30_000,
});

const response = await engine.deliberate(messages, config);
```

### `GroqTransport`

Production transport using the Groq API (Llama 3.3 70B, Llama 3.1 8B, Mixtral).

```ts
new GroqTransport({
  apiKey: process.env.GROQ_API_KEY,
  model: "llama-3.3-70b-versatile",
  temperature: 0.1,
});
```

### `summonArchetypes`

Returns a list of `Archetype` presets that prime the council with different reasoning perspectives.

```ts
summonArchetypes(["deliberative", "analytical", "risk-analyst", "creative"]);
```

Each archetype injects a system prompt that shapes how that council member frames its response.

### `CouncilService`

High-level wrapper: takes a question + context, selects archetypes, calls the engine, persists the transcript to `council_transcripts`, and returns a structured verdict.

## `ILLMTransport` interface

Implement this to add any provider:

```ts
interface ILLMTransport {
  id: string;
  send(messages: ILLMMessage[], config?: Partial<DeliberationEngineConfig>): Promise<ILLMResponse>;
}
```

## Voting modes

| Mode        | Behaviour                                                           |
| ----------- | ------------------------------------------------------------------- |
| `unanimous` | All providers must agree; disagreement → `defer`                    |
| `majority`  | Simple majority of provider verdicts wins                           |
| `weighted`  | Providers have configurable weight; weighted sum determines verdict |
