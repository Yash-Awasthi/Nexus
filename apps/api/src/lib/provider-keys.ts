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
  type LlmDriver,
} from "@nexus/llm-drivers";
import { and, eq, isNull } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "./secret-crypto.js";

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
 * Resolve a user's decrypted provider key. Returns null when the user has no
 * active key for that provider (or decryption fails). Best-effort bumps
 * last_used_at. NEVER expose the return value over HTTP.
 */
export async function resolveUserProviderKey(
  userId: string | undefined,
  provider: string,
): Promise<string | null> {
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
  if (!row?.encryptedKey) return null;
  try {
    const key = decryptSecret(row.encryptedKey);
    void db
      .update(userProviderCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(userProviderCredentials.id, row.id));
    return key;
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
      return maybePlain;
    } catch {
      return null;
    }
  }
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
    // Allowlist guard: `provider` is user-controlled, so only invoke a factory
    // that is an OWN property of DRIVER_FACTORIES. This rejects prototype-chain
    // names (e.g. "constructor", "__proto__", "toString") before the dynamic call.
    if (!Object.hasOwn(DRIVER_FACTORIES, provider)) {
      missing.push(provider);
      continue;
    }
    const factory = DRIVER_FACTORIES[provider];
    if (!factory) {
      missing.push(provider);
      continue;
    }
    const key = await resolveUserProviderKey(userId, provider);
    if (!key) {
      missing.push(provider);
      continue;
    }
    // factory() can throw on malformed composite creds (bedrock/vertex JSON blob).
    // Treat a construction failure as "not configured" rather than crashing the
    // whole registry build.
    try {
      registry.register(factory(key), provider);
    } catch {
      missing.push(provider);
    }
  }
  return { registry, missing };
}
