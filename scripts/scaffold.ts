// SPDX-License-Identifier: Apache-2.0
/**
 * Scaffolding generator for repetitive NEXUS package patterns.
 *
 * Usage (via pnpm):
 *   pnpm scaffold:adapter <name>    # new packages/adapters/<name> package
 *   pnpm scaffold:driver  <name>    # new OpenAI-compatible LLM driver class
 *
 * <name> must be lowercase letters, digits, and dashes (e.g. "linear", "x-ai").
 * Generators are idempotent-ish: they refuse to overwrite existing files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function pascal(name: string): string {
  return name
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function write(path: string, content: string): void {
  if (existsSync(path)) fail(`refusing to overwrite existing file: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`  + ${path.replace(`${ROOT}/`, "")}`);
}

// ── adapter generator ───────────────────────────────────────────────────────────

function scaffoldAdapter(name: string): void {
  const dir = join(ROOT, "packages", "adapters", name);
  if (existsSync(dir)) fail(`adapter already exists: packages/adapters/${name}`);
  const Pascal = pascal(name);
  const pkg = `nexus-adapter-${name}`;

  write(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `@nexus/adapter-${name}`,
        version: "0.0.0",
        private: false,
        description: `NEXUS adapter for ${name}`,
        license: "Apache-2.0",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
        scripts: {
          build: "tsc --project tsconfig.json",
          dev: "tsc --project tsconfig.json --watch",
          typecheck: "tsc --noEmit",
          lint: "eslint src/",
          clean: "rm -rf dist coverage",
          test: "vitest run --passWithNoTests",
        },
        devDependencies: { typescript: "^5.6.3" },
        dependencies: { "@nexus/plugin-sdk": "workspace:*" },
      },
      null,
      2,
    ) + "\n",
  );

  write(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../../tsconfig.base.json",
        compilerOptions: { outDir: "dist", rootDir: "src" },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );

  write(
    join(dir, "vitest.config.ts"),
    `// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
`,
  );

  write(
    join(dir, "src", "index.ts"),
    `// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-${name} — TODO: describe what this integrates.
 * Task types: ${name}.example
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

export interface ${Pascal}ExampleTask {
  taskType: "${name}.example";
  input: string;
}
export type ${Pascal}Task = ${Pascal}ExampleTask;

export interface ${Pascal}Result {
  ok: boolean;
  output: string;
}

async function execute(task: ${Pascal}Task, ctx: IExecutionContext): Promise<${Pascal}Result> {
  const token = requireEnv(ctx, "${name.toUpperCase().replace(/-/g, "_")}_API_KEY");
  ctx.logger.info("${name}.example", { input: task.input });

  const response = await fetch("https://api.example.com/v1/do", {
    method: "POST",
    headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: task.input }),
  });
  if (!response.ok)
    throw new AdapterHttpError("${pkg}", response.status, await response.text());

  const data = (await response.json()) as Record<string, unknown>;
  return { ok: true, output: String(data["output"] ?? "") };
}

export const ${name.replace(/-/g, "")}Adapter = defineAdapter<${Pascal}Task, ${Pascal}Result>({
  name: "${pkg}",
  version: "0.1.0",
  capabilities: [],
  taskTypes: ["${name}.example"],
  execute,
});
export default ${name.replace(/-/g, "")}Adapter;
`,
  );

  write(
    join(dir, "tests", "index.test.ts"),
    `// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ${name.replace(/-/g, "")}Adapter } from "../src/index.js";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      json: vi.fn().mockResolvedValue(body),
    }),
  );
}

const ENV = { ${name.toUpperCase().replace(/-/g, "_")}_API_KEY: "test-key" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("${name.replace(/-/g, "")}Adapter", () => {
  it("has the correct name", () =>
    expect(${name.replace(/-/g, "")}Adapter.name).toBe("${pkg}"));

  it("handles ${name}.example", () =>
    expect(${name.replace(/-/g, "")}Adapter.canExecute("${name}.example")).toBe(true));

  it("rejects unknown task types", () =>
    expect(${name.replace(/-/g, "")}Adapter.canExecute("other.task")).toBe(false));

  it("executes and returns a result", async () => {
    mockFetch(200, { output: "done" });
    const result = await ${name.replace(/-/g, "")}Adapter.execute(
      { taskType: "${name}.example", input: "hi" },
      makeCtx(ENV),
    );
    expect(result.ok).toBe(true);
  });

  it("throws AdapterConfigError when the API key is missing", async () => {
    await expect(
      ${name.replace(/-/g, "")}Adapter.execute(
        { taskType: "${name}.example", input: "hi" },
        makeCtx({}),
      ),
    ).rejects.toThrow(AdapterConfigError);
  });

  it("throws AdapterHttpError on HTTP failure", async () => {
    mockFetch(403, "Forbidden");
    await expect(
      ${name.replace(/-/g, "")}Adapter.execute(
        { taskType: "${name}.example", input: "hi" },
        makeCtx(ENV),
      ),
    ).rejects.toThrow(AdapterHttpError);
  });
});
`,
  );

  write(
    join(dir, "README.md"),
    `<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/adapter-${name}

NEXUS adapter for ${name}

**Status:** Skeleton — implementation pending.
`,
  );

  console.log(`\n✓ Scaffolded packages/adapters/${name}`);
  console.log("  Next: pnpm install && pnpm --filter @nexus/adapter-" + name + " test");
}

// ── driver generator ────────────────────────────────────────────────────────────

function scaffoldDriver(name: string): void {
  const file = join(ROOT, "packages", "llm-drivers", "src", "index.ts");
  let src = readFileSync(file, "utf8");
  const Class = `${pascal(name)}Driver`;
  if (src.includes(`class ${Class} `)) fail(`driver class already exists: ${Class}`);

  const marker = "// ── Driver registry + factory ──";
  if (!src.includes(marker)) fail(`could not find insertion marker in ${file}`);

  const block = `// ── ${pascal(name)} ────────────────────────────────────────────────────────────

export class ${Class} extends OpenAICompatibleDriver {
  readonly provider = "${name}";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.example.com/v1";
    this.model = config.model ?? "TODO-default-model";
  }
}

`;
  src = src.replace(marker, block + marker);

  // Append to the ProviderName union (before its closing semicolon).
  src = src.replace(
    /(export type ProviderName =[\s\S]*?)(;\n)/,
    (_m, body: string, end: string) => `${body}\n  | "${name}"${end}`,
  );

  writeFileSync(file, src);
  console.log(`  ~ packages/llm-drivers/src/index.ts (added ${Class} + ProviderName)`);
  console.log(`\n✓ Scaffolded driver ${Class}. Now wire it up:`);
  console.log("  1. set baseUrl + default model in the new class");
  console.log("  2. apps/api/src/lib/provider-keys.ts        → import + DRIVER_FACTORIES");
  console.log("  3. apps/api/src/routes/api-bridge.ts        → VALID_PROVIDERS");
  console.log("  4. apps/ui/app/routes/provider-keys.tsx     → PROVIDERS");
  console.log("  5. apps/ui/app/lib/council.ts               → API_PROVIDERS metadata");
  console.log("  6. packages/llm-drivers/tests/llm-drivers.test.ts → add to describe.each");
}

// ── domain-feed generator ───────────────────────────────────────────────────────

function scaffoldFeed(name: string): void {
  const file = join(ROOT, "packages", "domain-feeds", "src", "index.ts");
  let src = readFileSync(file, "utf8");
  const Pascal = pascal(name);
  const Event = `${Pascal}Event`;
  const Feed = `${Pascal}Feed`;
  if (src.includes(`class ${Feed} `)) fail(`feed class already exists: ${Feed}`);

  const block = `
// ── ${Pascal} — TODO: describe the source ──────────────────────────────────────

export interface ${Event} extends FeedEvent {
  /** TODO: replace with domain-specific fields. */
  category?: string;
}

export class ${Feed} extends FeedAdapter<${Event}> {
  readonly domain = "${name}";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.example.com", ...opts });
  }

  async fetch(): Promise<${Event}[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    try {
      const raw = await this.http(\`\${this.baseUrl}/${name}/events\`, this.buildHeaders());
      if (Array.isArray(raw)) return raw as ${Event}[];
      return buildMockResponse<${Event}>("${name}");
    } catch {
      return buildMockResponse<${Event}>("${name}");
    }
  }
}
`;
  // Append at EOF — classes/interfaces are import-only, so order doesn't matter.
  src = src.replace(/\s*$/, "\n") + block;
  writeFileSync(file, src);
  console.log(`  ~ packages/domain-feeds/src/index.ts (added ${Event} + ${Feed})`);
  console.log(`\n✓ Scaffolded feed ${Feed}. Now finish it:`);
  console.log("  1. set baseUrl + parse real events in fetch() (see AviationFeed)");
  console.log("  2. register it in createDefaultRegistry() in the same file");
  console.log("  3. add a test under packages/domain-feeds/tests/");
}

// ── entry ─────────────────────────────────────────────────────────────────────

function main(): void {
  const [kind, name] = process.argv.slice(2);
  if (!kind || !name) fail("usage: tsx scripts/scaffold.ts <adapter|driver|feed> <name>");
  if (!NAME_RE.test(name)) fail(`invalid name "${name}" — use lowercase letters, digits, dashes`);

  switch (kind) {
    case "adapter":
      return scaffoldAdapter(name);
    case "driver":
      return scaffoldDriver(name);
    case "feed":
      return scaffoldFeed(name);
    default:
      fail(`unknown kind "${kind}" — expected "adapter", "driver", or "feed"`);
  }
}

main();
