// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user BYOK provider-key resolution (server-side only).
 *
 * Keys live encrypted in user_provider_credentials; this module decrypts them at
 * request time and builds a per-request DriverRegistry containing ONLY the
 * providers the user has configured. Strict policy: there is no env-var
 * fallback — a user with no stored key for a provider cannot use it.
 */
import { db } from "@nexus/db";
import { userProviderCredentials } from "@nexus/db/schema";
import {
  DriverRegistry,
  AnthropicDriver,
  GroqDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  OpenRouterDriver,
  OpenAIDriver,
  XaiDriver,
  TogetherDriver,
  PerplexityDriver,
  CohereDriver,
  CerebrasDriver,
  ZhipuDriver,
  MoonshotDriver,
  ZeroOneDriver,
  BaichuanDriver,
  MiniMaxDriver,
  StepFunDriver,
  NovitaDriver,
  SiliconFlowDriver,
  HyperbolicDriver,
  ChutesDriver,
  NebiusDriver,
  VeniceDriver,
  QwenDriver,
  Ai360Driver,
  VercelAIGatewayDriver,
  DoubaoDriver,
  BytePlusDriver,
  HunyuanDriver,
  SparkDriver,
  AzureOpenAIDriver,
  CloudflareWorkersAIDriver,
  ReplicateDriver,
  BaiduErnieDriver,
  AlibabaBailianDriver,
  DifyDriver,
  BedrockDriver,
  VertexDriver,
  CompatibleEndpointDriver,
  type LlmDriver,
} from "@nexus/llm-drivers";
import { and, eq, isNull } from "drizzle-orm";

import { IdleMap } from "./idle-map.js";
import { cachedDriver } from "./llm-cache-driver.js";
import { callerFetch, unsafeUrlReason } from "./public-url.js";
import { pacedFetch } from "./rate-pace.js";
import type { LlmStep } from "./request-traces.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";
import { userContext, type UserDriver } from "./user-context.js";

/** Providers we can construct an LLM driver for (openai included — the ChatGPT
 *  API is a plain OpenAI-compatible endpoint and its driver lives in
 *  @nexus/llm-drivers; REST-only consumers (image-gen/moderation) keep their
 *  own direct calls). */
const DRIVER_FACTORIES: Record<string, (apiKey: string) => LlmDriver> = {
  anthropic: (apiKey) => new AnthropicDriver({ apiKey }),
  openai: (apiKey) => new OpenAIDriver({ apiKey }),
  groq: (apiKey) => new GroqDriver({ apiKey }),
  gemini: (apiKey) => new GeminiDriver({ apiKey }),
  deepseek: (apiKey) => new DeepSeekDriver({ apiKey }),
  mistral: (apiKey) => new MistralDriver({ apiKey }),
  openrouter: (apiKey) => new OpenRouterDriver({ apiKey }),
  xai: (apiKey) => new XaiDriver({ apiKey }),
  together: (apiKey) => new TogetherDriver({ apiKey }),
  perplexity: (apiKey) => new PerplexityDriver({ apiKey }),
  cohere: (apiKey) => new CohereDriver({ apiKey }),
  cerebras: (apiKey) => new CerebrasDriver({ apiKey }),
  zhipu: (apiKey) => new ZhipuDriver({ apiKey }),
  moonshot: (apiKey) => new MoonshotDriver({ apiKey }),
  zeroone: (apiKey) => new ZeroOneDriver({ apiKey }),
  baichuan: (apiKey) => new BaichuanDriver({ apiKey }),
  minimax: (apiKey) => new MiniMaxDriver({ apiKey }),
  stepfun: (apiKey) => new StepFunDriver({ apiKey }),
  novita: (apiKey) => new NovitaDriver({ apiKey }),
  siliconflow: (apiKey) => new SiliconFlowDriver({ apiKey }),
  hyperbolic: (apiKey) => new HyperbolicDriver({ apiKey }),
  chutes: (apiKey) => new ChutesDriver({ apiKey }),
  nebius: (apiKey) => new NebiusDriver({ apiKey }),
  venice: (apiKey) => new VeniceDriver({ apiKey }),
  qwen: (apiKey) => new QwenDriver({ apiKey }),
  ai360: (apiKey) => new Ai360Driver({ apiKey }),
  vercel_ai_gateway: (apiKey) => new VercelAIGatewayDriver({ apiKey }),
  doubao: (apiKey) => new DoubaoDriver({ apiKey }),
  byteplus: (apiKey) => new BytePlusDriver({ apiKey }),
  hunyuan: (apiKey) => new HunyuanDriver({ apiKey }),
  spark: (apiKey) => new SparkDriver({ apiKey }),
  replicate: (apiKey) => new ReplicateDriver({ apiKey }),
  // Alibaba Bailian/DashScope (Qwen) via OpenAI compatible-mode — plain key.
  alibaba_bailian: (apiKey) => new AlibabaBailianDriver({ apiKey }),
  // Dify is app-scoped: the key authenticates one app. Optional baseUrl (self-host)
  // + user travel as a JSON blob, same convention as the composite-cred providers.
  dify: (key) => new DifyDriver(JSON.parse(key) as ConstructorParameters<typeof DifyDriver>[0]),
  // Azure & Cloudflare also need composite credentials (endpoint+deployment /
  // accountId alongside the key). Same JSON-blob convention as bedrock/vertex.
  azure_openai: (key) =>
    new AzureOpenAIDriver(JSON.parse(key) as ConstructorParameters<typeof AzureOpenAIDriver>[0]),
  cloudflare: (key) =>
    new CloudflareWorkersAIDriver(
      JSON.parse(key) as ConstructorParameters<typeof CloudflareWorkersAIDriver>[0],
    ),
  // ERNIE needs client-credentials (clientId + clientSecret), not a single key.
  // Same JSON-blob convention as azure/cloudflare/bedrock.
  baidu_ernie: (key) =>
    new BaiduErnieDriver(JSON.parse(key) as ConstructorParameters<typeof BaiduErnieDriver>[0]),
  // Bedrock & Vertex need composite credentials, not a single key. The stored
  // secret is a JSON blob; parse it here. A malformed blob throws, which the
  // caller treats as "provider not configured" (same as a missing key).
  bedrock: (key) =>
    new BedrockDriver(JSON.parse(key) as ConstructorParameters<typeof BedrockDriver>[0]),
  vertex: (key) =>
    new VertexDriver(JSON.parse(key) as ConstructorParameters<typeof VertexDriver>[0]),
};

/**
 * Why a named OpenAI-compatible connection cannot be saved, or null when it can.
 * Off the desktop, private origins are refused here and again, after DNS, by the pinned fetch.
 */
export function compatibleEndpointError(
  provider: string,
  baseUrl: string,
  models: string[] | undefined,
): string | null {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(provider)) return "name must be a lowercase slug";
  if (Object.hasOwn(DRIVER_FACTORIES, provider)) return `${provider} is a built-in provider`;
  if (unsafeUrlReason(baseUrl)) return "unsafe base URL (SSRF guard)";
  if (!models?.[0]) return "a default model is required";
  return null;
}

/**
 * Resolve a user's decrypted provider key. Returns null when the user has no
 * active key for that provider (or decryption fails). Best-effort bumps
 * last_used_at. NEVER expose the return value over HTTP.
 */
async function resolveUserProviderKey(
  userId: string | undefined,
  provider: string,
): Promise<string | null> {
  return (await resolveUserConnection(userId, provider))?.key ?? null;
}

/** A user's decrypted key plus the connection's base URL and models. */
async function resolveUserConnection(
  userId: string | undefined,
  provider: string,
): Promise<{ key: string | null; baseUrl: string | null; models: string[] | null } | null> {
  if (!userId) return null;
  const [row] = await db
    .select()
    .from(userProviderCredentials)
    .where(
      and(
        eq(userProviderCredentials.userId, userId),
        eq(userProviderCredentials.provider, provider),
        isNull(userProviderCredentials.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const meta = { baseUrl: row.baseUrl, models: row.models };
  // A keyless connection is a local server such as Ollama.
  if (!row.encryptedKey) return row.baseUrl ? { key: null, ...meta } : null;
  try {
    const key = decryptSecret(row.encryptedKey);
    void db
      .update(userProviderCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(userProviderCredentials.id, row.id));
    return { key, ...meta };
  } catch {
    // Read-time migration: a legacy row may hold a PLAINTEXT key written before
    // at-rest encryption existed. Detect it (a token-shaped string that fails
    // GCM auth — JSON blobs for composite providers are not re-encryptable here
    // and stay unreadable, same as before), re-encrypt it in place, and use it.
    // Picked over a one-time migration: safe under concurrent writers, needs no
    // downtime, and upgrades rows the moment they are first used.
    const maybePlain = row.encryptedKey;
    const tokenShaped =
      maybePlain.length >= 12 &&
      maybePlain.length <= 2048 &&
      /^[A-Za-z0-9_\-.]+$/.test(maybePlain) &&
      /[A-Za-z]{4}/.test(maybePlain);
    if (!tokenShaped) return null;
    try {
      const reencrypted = encryptSecret(maybePlain);
      await db
        .update(userProviderCredentials)
        .set({ encryptedKey: reencrypted, lastUsedAt: new Date() })
        .where(eq(userProviderCredentials.id, row.id));
      return { key: maybePlain, ...meta };
    } catch {
      return null;
    }
  }
}

const _pacedFetch = pacedFetch(callerFetch);

/** A driver builder for a stored connection: a built-in provider, else an OpenAI-compatible endpoint. */
function driverFor(
  provider: string,
  key: string | null,
  conn: { baseUrl: string | null; models: string[] | null },
): (() => LlmDriver) | undefined {
  // `provider` is user-controlled: only an OWN factory may run, never "constructor" or "__proto__".
  if (Object.hasOwn(DRIVER_FACTORIES, provider))
    return key ? () => DRIVER_FACTORIES[provider]!(key) : undefined;
  const { baseUrl } = conn;
  const model = conn.models?.[0];
  if (!baseUrl || !model) return undefined;
  return () =>
    new CompatibleEndpointDriver({
      provider,
      apiKey: key ?? "",
      baseUrl,
      model,
      fetch: _pacedFetch,
    });
}

/**
 * Build a per-request DriverRegistry from the user's stored keys for the given
 * providers. Returns the registry plus the list of providers that could not be
 * registered (no stored key, or unsupported provider) so callers can surface a
 * precise error per provider/model.
 */
export async function buildUserDriverRegistry(
  userId: string | undefined,
  providers: Iterable<string>,
): Promise<{ registry: DriverRegistry; missing: string[] }> {
  const registry = new DriverRegistry();
  const missing: string[] = [];
  for (const provider of new Set(providers)) {
    const conn = await resolveUserConnection(userId, provider);
    const build = conn ? driverFor(provider, conn.key, conn) : undefined;
    if (!build) {
      missing.push(provider);
      continue;
    }
    // factory() can throw on malformed composite creds (bedrock/vertex JSON blob).
    // Treat a construction failure as "not configured" rather than crashing the
    // whole registry build.
    try {
      registry.register(cachedDriver(build()), provider);
    } catch {
      missing.push(provider);
    }
  }
  return { registry, missing };
}

// Per-request callers (every /api request) read this, so decrypted drivers are
// kept briefly; saving or deleting a key drops the entry at once.
const USER_DRIVER_TTL_MS = 30_000;
const _userDrivers = new IdleMap<string, { at: number; drivers: UserDriver[] }>(USER_DRIVER_TTL_MS);

export function invalidateUserDrivers(userId: string | undefined): void {
  if (userId) _userDrivers.delete(userId);
}

/** Drivers for every provider the user has saved a key for, in save order. */
export async function listUserDrivers(userId: string | undefined): Promise<UserDriver[]> {
  if (!userId) return [];
  const hit = _userDrivers.get(userId);
  if (hit && Date.now() - hit.at < USER_DRIVER_TTL_MS) return hit.drivers;
  const rows = await db
    .select({ provider: userProviderCredentials.provider, models: userProviderCredentials.models })
    .from(userProviderCredentials)
    .where(
      and(eq(userProviderCredentials.userId, userId), isNull(userProviderCredentials.deletedAt)),
    );
  const { registry } = await buildUserDriverRegistry(
    userId,
    rows.map((r) => r.provider),
  );
  const models = new Map(rows.map((r) => [r.provider, r.models ?? []]));
  const drivers = registry.list().flatMap((id) => {
    const driver = registry.get(id);
    return driver ? [{ id, driver, models: models.get(id) ?? [] }] : [];
  });
  _userDrivers.set(userId, { at: Date.now(), drivers });
  return drivers;
}

/** Each saved provider with the models its connection names (empty for a built-in's default). */
export async function listUserModels(
  userId: string | undefined,
): Promise<{ provider: string; models: string[] }[]> {
  if (!userId) return [];
  const rows = await db
    .select({ provider: userProviderCredentials.provider, models: userProviderCredentials.models })
    .from(userProviderCredentials)
    .where(
      and(eq(userProviderCredentials.userId, userId), isNull(userProviderCredentials.deletedAt)),
    );
  return rows.map((r) => ({ provider: r.provider, models: r.models ?? [] }));
}

/** The OpenAI-style base URL and key of a saved connection; `knownBase` covers built-ins. */
export async function userEndpoint(
  userId: string | undefined,
  provider: string,
  knownBase: Record<string, string>,
): Promise<{ baseUrl: string; key: string | null } | null> {
  const conn = await resolveUserConnection(userId, provider);
  const baseUrl = conn?.baseUrl ?? (Object.hasOwn(knownBase, provider) ? knownBase[provider] : "");
  return conn && baseUrl ? { baseUrl, key: conn.key } : null;
}

/** Run `fn` as `userId` with the provider keys they saved, as one of their requests would. */
export async function asUser<T>(
  userId: string | null,
  fn: () => T,
  llmSteps?: LlmStep[],
): Promise<Awaited<T>> {
  const userDrivers = userId ? await listUserDrivers(userId).catch(() => []) : [];
  return await userContext.run({ userId, userDrivers, ...(llmSteps ? { llmSteps } : {}) }, fn);
}

/**
 * A service key for the current caller: the one they saved, else the server's
 * env var. Outside a request (no caller) only the env var applies.
 */
export async function serviceKey(
  userId: string | null | undefined,
  provider: string,
  envVar: string,
): Promise<string | undefined> {
  const saved = userId ? await resolveUserProviderKey(userId, provider).catch(() => null) : null;
  return saved ?? process.env[envVar] ?? undefined;
}
