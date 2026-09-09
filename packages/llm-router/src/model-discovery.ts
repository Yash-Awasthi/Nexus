// SPDX-License-Identifier: Apache-2.0
/**
 * Automatic model discovery from multiple LLM backends.
 *
 * Inspired by SmarterRouter's BackendRegistry — discovers available models
 * from all configured backends (Ollama, OpenAI, Anthropic, etc.)
 * and provides a unified catalog for routing.
 */

export interface DiscoveredModel {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  costPer1kInput: number;
  costPer1kOutput: number;
  avgLatencyMs: number;
  capabilities: string[];
}

export interface BackendConfig {
  type: "ollama" | "openai" | "anthropic" | "groq" | "custom";
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
}

export class ModelDiscovery {
  private models = new Map<string, DiscoveredModel>();
  private lastRefresh = 0;
  private refreshIntervalMs = 60_000;
  private backends: BackendConfig[];

  constructor(backends: BackendConfig[], options?: { refreshIntervalMs?: number }) {
    this.backends = backends.filter((b) => b.enabled);
    if (options?.refreshIntervalMs) {
      this.refreshIntervalMs = options.refreshIntervalMs;
    }
  }

  async discover(): Promise<DiscoveredModel[]> {
    if (Date.now() - this.lastRefresh < this.refreshIntervalMs && this.models.size > 0) {
      return Array.from(this.models.values());
    }

    const results = await Promise.allSettled(
      this.backends.map((backend) => this.discoverFromBackend(backend)),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const model of result.value) {
          this.models.set(`${model.provider}:${model.id}`, model);
        }
      }
    }

    this.lastRefresh = Date.now();
    return Array.from(this.models.values());
  }

  async getModel(provider: string, modelId: string): Promise<DiscoveredModel | undefined> {
    if (Date.now() - this.lastRefresh >= this.refreshIntervalMs) {
      await this.discover();
    }
    return this.models.get(`${provider}:${modelId}`);
  }

  async search(query: string): Promise<DiscoveredModel[]> {
    const all = await this.discover();
    const lower = query.toLowerCase();
    return all.filter(
      (m) =>
        m.id.toLowerCase().includes(lower) ||
        m.displayName.toLowerCase().includes(lower) ||
        m.capabilities.some((c) => c.toLowerCase().includes(lower)),
    );
  }

  getAvailableProviders(): string[] {
    return [...new Set(Array.from(this.models.values()).map((m) => m.provider))];
  }

  private async discoverFromBackend(backend: BackendConfig): Promise<DiscoveredModel[]> {
    switch (backend.type) {
      case "ollama":
        return this.discoverOllama(backend);
      case "openai":
        return this.discoverOpenAICompatible(backend, "openai");
      case "groq":
        return this.discoverOpenAICompatible(backend, "groq");
      case "anthropic":
        return this.discoverAnthropic(backend);
      default:
        return this.discoverOpenAICompatible(backend, backend.type);
    }
  }

  private async discoverOllama(backend: BackendConfig): Promise<DiscoveredModel[]> {
    try {
      const resp = await fetch(`${backend.baseUrl}/api/tags`);
      if (!resp.ok) return [];
      const data = (await resp.json()) as { models: { name: string; size: number }[] };
      return data.models.map((m) => ({
        id: m.name,
        provider: "ollama",
        displayName: m.name,
        contextWindow: 4096,
        supportsStreaming: true,
        supportsFunctionCalling: false,
        costPer1kInput: 0,
        costPer1kOutput: 0,
        avgLatencyMs: 2000,
        capabilities: ["local", "streaming"],
      }));
    } catch {
      return [];
    }
  }

  private async discoverOpenAICompatible(
    backend: BackendConfig,
    providerName: string,
  ): Promise<DiscoveredModel[]> {
    try {
      const headers: Record<string, string> = {};
      if (backend.apiKey) {
        headers["Authorization"] = `Bearer ${backend.apiKey}`;
      }
      const resp = await fetch(`${backend.baseUrl}/v1/models`, { headers });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { data: { id: string; owned_by?: string }[] };
      return data.data.map((m) => ({
        id: m.id,
        provider: providerName,
        displayName: m.id,
        contextWindow: this.estimateContextWindow(m.id),
        supportsStreaming: true,
        supportsFunctionCalling: this.supportsFunctionCalling(m.id),
        costPer1kInput: this.estimateCost(m.id, "input"),
        costPer1kOutput: this.estimateCost(m.id, "output"),
        avgLatencyMs: 1500,
        capabilities: this.inferCapabilities(m.id),
      }));
    } catch {
      return [];
    }
  }

  private async discoverAnthropic(backend: BackendConfig): Promise<DiscoveredModel[]> {
    try {
      const headers: Record<string, string> = {};
      if (backend.apiKey) {
        headers["x-api-key"] = backend.apiKey;
      }
      const resp = await fetch(`${backend.baseUrl}/v1/models`, { headers });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { data: { id: string }[] };
      return data.data.map((m) => ({
        id: m.id,
        provider: "anthropic",
        displayName: m.id,
        contextWindow: this.estimateContextWindow(m.id),
        supportsStreaming: true,
        supportsFunctionCalling: true,
        costPer1kInput: this.estimateCost(m.id, "input"),
        costPer1kOutput: this.estimateCost(m.id, "output"),
        avgLatencyMs: 2000,
        capabilities: this.inferCapabilities(m.id),
      }));
    } catch {
      return [];
    }
  }

  private estimateContextWindow(modelId: string): number {
    if (modelId.includes("100k") || modelId.includes("128k")) return 128_000;
    if (modelId.includes("32k")) return 32_000;
    if (modelId.includes("16k")) return 16_000;
    if (modelId.includes("claude-opus") || modelId.includes("claude-sonnet")) return 200_000;
    return 8_000;
  }

  private supportsFunctionCalling(modelId: string): boolean {
    const fcModels = ["gpt-4", "gpt-3.5-turbo", "claude", "gemini"];
    return fcModels.some((p) => modelId.includes(p));
  }

  private estimateCost(modelId: string, type: "input" | "output"): number {
    if (modelId.includes("opus")) return type === "input" ? 0.015 : 0.075;
    if (modelId.includes("sonnet")) return type === "input" ? 0.003 : 0.015;
    if (modelId.includes("haiku")) return type === "input" ? 0.00025 : 0.00125;
    if (modelId.includes("gpt-4o")) return type === "input" ? 0.0025 : 0.01;
    if (modelId.includes("gpt-4")) return type === "input" ? 0.03 : 0.06;
    if (modelId.includes("gpt-3.5")) return type === "input" ? 0.0005 : 0.0015;
    return 0;
  }

  private inferCapabilities(modelId: string): string[] {
    const caps: string[] = [];
    if (modelId.includes("vision") || modelId.includes("gpt-4o")) caps.push("vision");
    if (modelId.includes("code") || modelId.includes("starcoder")) caps.push("code");
    if (modelId.includes("embedding")) caps.push("embeddings");
    if (modelId.includes("instruct")) caps.push("instruction-following");
    if (modelId.includes("chat")) caps.push("chat");
    if (modelId.includes("turbo")) caps.push("speed");
    return caps.length > 0 ? caps : ["general"];
  }
}

export default ModelDiscovery;
