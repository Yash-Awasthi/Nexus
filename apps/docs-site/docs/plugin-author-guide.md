---
id: plugin-author-guide
title: "Plugin Author Guide"
sidebar_position: 5
---

# Plugin Author Guide

**Time to first adapter:** < 30 minutes  
**SDK:** `@nexus/plugin-sdk`  
**Reference:** `packages/adapters/github/src/index.ts` (fully worked example)

---

## 1. What is a NEXUS adapter?

An adapter is a TypeScript module that implements `IExecutionAdapter` from `@nexus/plugin-sdk`.
It exposes one or more **task types** (e.g., `github.create-issue`) and declares which
**capabilities** it provides (e.g., `storage.write`).

The runtime calls `canExecute(taskType)` to route a job, then `execute(task, context)` to run it.
Your adapter never imports Fastify, BullMQ, or any other infrastructure — it only depends on `@nexus/plugin-sdk`.

---

## 2. Prerequisites

```bash
node --version   # must be 20+
pnpm --version   # must be 9+
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus && pnpm install
```

---

## 3. Scaffold a new adapter

```bash
# Replace "myservice" with your service name (lowercase, hyphen-separated)
ADAPTER=myservice

mkdir -p packages/adapters/$ADAPTER/src
cd packages/adapters/$ADAPTER
```

### 3.1 `package.json`

```json
{
  "name": "@nexus/adapter-myservice",
  "version": "0.1.0",
  "private": false,
  "description": "NEXUS adapter for MyService",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist coverage"
  },
  "dependencies": {
    "@nexus/plugin-sdk": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

### 3.2 `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declarationDir": "dist"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

### 3.3 Register in `pnpm-workspace.yaml`

The adapter is auto-discovered because `packages/adapters/*` is already in the workspace.
Run `pnpm install` to link it.

---

## 4. Implement the adapter

### 4.1 Define your task types

```typescript
// packages/adapters/myservice/src/index.ts
// SPDX-License-Identifier: Apache-2.0
import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

// --- Input types ---
export interface MyServiceSendTask {
  taskType: "myservice.send";
  message: string;
  channel: string;
}

export interface MyServiceGetTask {
  taskType: "myservice.get";
  resourceId: string;
}

export type MyServiceTask = MyServiceSendTask | MyServiceGetTask;

// --- Execute function ---
async function execute(task: MyServiceTask, ctx: IExecutionContext): Promise<unknown> {
  const apiKey = requireEnv(ctx, "MYSERVICE_API_KEY");
  const baseUrl = (ctx.env?.["MYSERVICE_BASE_URL"] as string) ?? "https://api.myservice.com";

  switch (task.taskType) {
    case "myservice.send": {
      ctx.logger.info("myservice.send", { channel: task.channel });
      const res = await fetch(`${baseUrl}/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: task.message, channel: task.channel }),
      });
      if (!res.ok) {
        throw new AdapterHttpError("nexus-adapter-myservice", res.status, await res.text());
      }
      return res.json();
    }

    case "myservice.get": {
      ctx.logger.info("myservice.get", { resourceId: task.resourceId });
      const res = await fetch(`${baseUrl}/resources/${task.resourceId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        throw new AdapterHttpError("nexus-adapter-myservice", res.status, await res.text());
      }
      return res.json();
    }

    default: {
      const _exhaustive: never = task;
      throw new Error(`Unhandled task type: ${(_exhaustive as MyServiceTask).taskType}`);
    }
  }
}

// --- Export the adapter ---
export const myServiceAdapter = defineAdapter<MyServiceTask, unknown>({
  name: "nexus-adapter-myservice",
  version: "0.1.0",
  capabilities: ["communication.chat"],   // pick from AdapterCapability union
  taskTypes: ["myservice.send", "myservice.get"],
  execute,
});

export default myServiceAdapter;
```

---

## 5. Available capabilities

Pick the appropriate capability from this union (defined in `@nexus/plugin-sdk`):

```typescript
type AdapterCapability =
  | "llm.inference"
  | "storage.read" | "storage.write"
  | "search.web"
  | "communication.email" | "communication.chat"
  | "database.query" | "database.execute"
  | "secrets.read"
  | "monitoring.log" | "monitoring.alert"
  | "deploy.trigger"
  | "scraping.financial"
  | "deliberation.council"
  | "auth.verify";
```

---

## 6. Use the execution context

The `IExecutionContext` gives you:

```typescript
ctx.logger           // structured logger (info/warn/error/debug)
ctx.env              // read-only env var map
ctx.traceId          // distributed trace ID for correlation
ctx.workspaceId      // tenant isolation
ctx.requestId        // unique request ID
```

**Never** use `process.env` directly — always go through `requireEnv(ctx, "KEY")` or `ctx.env`.
This ensures:
- Values are validated at call time, not at import time
- Secrets are never logged
- Tests can inject mock contexts

---

## 7. Error handling

```typescript
import { AdapterHttpError, AdapterTimeoutError, AdapterConfigError, withTimeout } from "@nexus/plugin-sdk";

// HTTP errors
if (!res.ok) throw new AdapterHttpError("nexus-adapter-myservice", res.status, body);

// Timeout guard (30 seconds)
const result = await withTimeout(someSlowCall(), 30_000, "nexus-adapter-myservice", "myservice.send");

// Missing config
const key = requireEnv(ctx, "MYSERVICE_API_KEY");  // throws AdapterConfigError if missing
```

All three error classes are caught by the runtime and routed to the DLQ with full metadata.

---

## 8. Testing your adapter

```typescript
// packages/adapters/myservice/tests/myservice.test.ts
import { describe, it, expect, vi } from "vitest";
import { createMockContext, createStubAdapter } from "@nexus/plugin-sdk/testing";
import { myServiceAdapter } from "../src/index.js";

describe("myServiceAdapter", () => {
  it("canExecute myservice.send", () => {
    expect(myServiceAdapter.canExecute("myservice.send")).toBe(true);
    expect(myServiceAdapter.canExecute("slack.post")).toBe(false);
  });

  it("executes myservice.send", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "msg-123", ok: true }),
    } as unknown as Response);

    const ctx = createMockContext({ env: { MYSERVICE_API_KEY: "test-key" } });
    const result = await myServiceAdapter.execute(
      { taskType: "myservice.send", message: "hello", channel: "general" },
      ctx,
    );

    expect(result).toEqual({ id: "msg-123", ok: true });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/send"), expect.any(Object));
  });
});
```

Run tests:
```bash
pnpm --filter @nexus/adapter-myservice test
```

---

## 9. Register the adapter in the worker

Add your adapter to the task worker's dispatcher in `apps/worker/src/workers/task-worker.ts`:

```typescript
import { myServiceAdapter } from "@nexus/adapter-myservice";

// In processJob():
case "myservice.send":
case "myservice.get":
  return myServiceAdapter.execute(data, buildContext(job));
```

---

## 10. Contributing your adapter

1. Ensure `pnpm typecheck` and `pnpm test` pass
2. Add a `README.md` to `packages/adapters/myservice/` documenting env vars
3. Open a PR with label `adapter-proposal`
4. A maintainer will review within 5 business days

See `CONTRIBUTING.md` for DCO sign-off requirements.

---

## Reference adapters (study these)

| Adapter | Complexity | Patterns demonstrated |
|---------|-----------|----------------------|
| `packages/adapters/groq` | Low | LLM inference, single API call |
| `packages/adapters/github` | Medium | Multi-task-type switch, CRUD operations |
| `packages/adapters/gmail` | Medium | RFC 2822 construction, base64 encoding |
| `packages/adapters/linear` | Medium | GraphQL API |
| `packages/adapters/neon` | Low | SQL via HTTP API (no driver) |
