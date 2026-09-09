// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/resource-manager — GPU/CPU resource management with mutual exclusion.
 *
 * Inspired by aigate's CUDA/CPU resource manager.
 * Enforces mutual exclusion for hardware resources, manages competing groups,
 * and handles VRAM/RAM eviction between services.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type HardwareType = "cuda" | "cpu" | "metal";

export interface ResourceGroup {
  name: string;
  hardware: HardwareType;
  models: string[];
  priority: number;
}

export interface ResourceRequest {
  modelId: string;
  hardware: HardwareType;
  vramRequiredMb?: number;
  ramRequiredMb?: number;
}

export interface ResourceAllocation {
  groupId: string;
  modelId: string;
  allocatedAt: number;
  hardware: HardwareType;
}

// ── Semaphore ────────────────────────────────────────────────────────────────

class AsyncSemaphore {
  private queue: Array<() => void> = [];
  private permits: number;

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}

// ── Resource Manager ─────────────────────────────────────────────────────────

export class ResourceManager {
  private groups: Map<string, ResourceGroup> = new Map();
  private semaphores: Map<HardwareType, AsyncSemaphore> = new Map();
  private activeAllocations: Map<string, ResourceAllocation> = new Map();
  private unloadCallbacks: Map<string, (modelId: string) => Promise<void>> = new Map();
  private modelGroupMap: Map<string, string> = new Map();

  constructor() {
    this.semaphores.set("cuda", new AsyncSemaphore(1));
    this.semaphores.set("cpu", new AsyncSemaphore(1));
    this.semaphores.set("metal", new AsyncSemaphore(1));
  }

  /**
   * Register a resource group.
   */
  registerGroup(group: ResourceGroup): void {
    this.groups.set(group.name, group);
    for (const model of group.models) {
      this.modelGroupMap.set(model, group.name);
    }
  }

  /**
   * Register an unload callback for a model.
   */
  registerUnloadCallback(modelPrefix: string, callback: (modelId: string) => Promise<void>): void {
    this.unloadCallbacks.set(modelPrefix, callback);
  }

  /**
   * Acquire exclusive access to a hardware resource for a model.
   * Unloads competing groups before acquiring.
   */
  async acquire(request: ResourceRequest): Promise<ResourceAllocation> {
    const groupName = this.modelGroupMap.get(request.modelId);
    const group = groupName ? this.groups.get(groupName) : undefined;

    // 1. Unload competing groups on the same hardware
    await this.unloadCompetingGroups(request.hardware, groupName);

    // 2. Acquire the semaphore (mutual exclusion)
    const semaphore = this.semaphores.get(request.hardware);
    if (semaphore) {
      await semaphore.acquire();
    }

    // 3. Register the allocation
    const allocation: ResourceAllocation = {
      groupId: groupName ?? "ungrouped",
      modelId: request.modelId,
      allocatedAt: Date.now(),
      hardware: request.hardware,
    };

    this.activeAllocations.set(request.modelId, allocation);
    return allocation;
  }

  /**
   * Release access to a hardware resource.
   */
  async release(modelId: string): Promise<void> {
    const allocation = this.activeAllocations.get(modelId);
    if (!allocation) return;

    this.activeAllocations.delete(modelId);

    const semaphore = this.semaphores.get(allocation.hardware);
    if (semaphore) {
      semaphore.release();
    }
  }

  /**
   * Execute a function with exclusive hardware access.
   */
  async withExclusiveAccess<T>(request: ResourceRequest, fn: () => Promise<T>): Promise<T> {
    const allocation = await this.acquire(request);
    try {
      return await fn();
    } finally {
      await this.release(allocation.modelId);
    }
  }

  /**
   * Get all active allocations.
   */
  getActiveAllocations(): ResourceAllocation[] {
    return Array.from(this.activeAllocations.values());
  }

  /**
   * Get groups for a hardware type.
   */
  getGroups(hardware?: HardwareType): ResourceGroup[] {
    const groups = Array.from(this.groups.values());
    return hardware ? groups.filter((g) => g.hardware === hardware) : groups;
  }

  /**
   * Force unload all models in a group.
   */
  async unloadGroup(groupName: string): Promise<void> {
    const group = this.groups.get(groupName);
    if (!group) return;

    for (const modelId of group.models) {
      const callback = this.findUnloadCallback(modelId);
      if (callback) {
        await callback(modelId);
      }
      this.activeAllocations.delete(modelId);
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private async unloadCompetingGroups(
    hardware: HardwareType,
    excludeGroup?: string,
  ): Promise<void> {
    const competingGroups = Array.from(this.groups.values()).filter(
      (g) => g.hardware === hardware && g.name !== excludeGroup,
    );

    // Sort by priority (lower priority = unload first)
    competingGroups.sort((a, b) => a.priority - b.priority);

    for (const group of competingGroups) {
      const hasActiveModels = group.models.some((m) => this.activeAllocations.has(m));
      if (hasActiveModels) {
        await this.unloadGroup(group.name);
      }
    }
  }

  private findUnloadCallback(modelId: string): ((modelId: string) => Promise<void>) | undefined {
    for (const [prefix, callback] of this.unloadCallbacks) {
      if (modelId.startsWith(prefix)) {
        return callback;
      }
    }
    return undefined;
  }
}

export default ResourceManager;

// ── VRAM Manager ─────────────────────────────────────────────────────────────

/**
 * VRAMManager — GPU memory allocation and model lifecycle management.
 * Inspired by SmarterRouter's vram_manager.py.
 * Tracks loaded models, checks VRAM budget, proactively unloads models (LRU/largest).
 */

export interface VRAMModel {
  name: string;
  vramGb: number;
  lastUsed: number;
  pinned: boolean;
}

export type UnloadStrategy = "lru" | "largest";

export interface VRAMManagerConfig {
  maxVramGb: number;
  autoUnload?: boolean;
  unloadStrategy?: UnloadStrategy;
  fragmentationBufferGb?: number;
}

export class VRAMManager {
  private readonly maxVram: number;
  private readonly autoUnload: boolean;
  private readonly unloadStrategy: UnloadStrategy;
  private readonly fragmentationBuffer: number;
  private readonly loaded = new Map<string, VRAMModel>();
  private pinnedModel: string | null = null;
  private unloadCallback?: (modelId: string) => Promise<void>;

  constructor(config: VRAMManagerConfig) {
    this.maxVram = config.maxVramGb;
    this.autoUnload = config.autoUnload ?? true;
    this.unloadStrategy = config.unloadStrategy ?? "lru";
    this.fragmentationBuffer = config.fragmentationBufferGb ?? 1.5;
  }

  /** Set callback to actually unload a model from GPU. */
  setUnloadCallback(cb: (modelId: string) => Promise<void>): void {
    this.unloadCallback = cb;
  }

  /** Get available VRAM in GB. */
  getAvailableVram(): number {
    const used = Array.from(this.loaded.values()).reduce((s, m) => s + m.vramGb, 0);
    return Math.max(0, this.maxVram - this.fragmentationBuffer - used);
  }

  /** Check if a model can fit in available VRAM. */
  canFit(vramNeededGb: number): boolean {
    return this.getAvailableVram() >= vramNeededGb;
  }

  /**
   * Try to load a model. Returns true if loaded, false if not enough VRAM.
   * If autoUnload is enabled, will try to make room by unloading other models.
   */
  async tryLoad(name: string, vramGb: number, pinned = false): Promise<boolean> {
    if (this.loaded.has(name)) {
      // Already loaded, update last used
      const m = this.loaded.get(name)!;
      m.lastUsed = Date.now();
      return true;
    }

    // Try to fit directly
    if (this.canFit(vramGb)) {
      this.loaded.set(name, { name, vramGb, lastUsed: Date.now(), pinned });
      if (pinned) this.pinnedModel = name;
      return true;
    }

    // Try auto-unload to make room
    if (this.autoUnload) {
      const freed = await this.evictModels(vramGb);
      if (freed >= vramGb) {
        this.loaded.set(name, { name, vramGb, lastUsed: Date.now(), pinned });
        if (pinned) this.pinnedModel = name;
        return true;
      }
    }

    return false;
  }

  /** Unload a model. */
  async unload(name: string): Promise<void> {
    const model = this.loaded.get(name);
    if (!model || model.pinned) return;
    this.loaded.delete(name);
    await this.unloadCallback?.(name);
  }

  /** Evict models to free at least targetGb. Returns amount freed. */
  private async evictModels(targetGb: number): Promise<number> {
    let freed = 0;
    const candidates = Array.from(this.loaded.values())
      .filter((m) => !m.pinned)
      .sort((a, b) => {
        if (this.unloadStrategy === "largest") return b.vramGb - a.vramGb;
        return a.lastUsed - b.lastUsed; // LRU
      });

    for (const m of candidates) {
      if (freed >= targetGb) break;
      freed += m.vramGb;
      this.loaded.delete(m.name);
      await this.unloadCallback?.(m.name);
    }

    return freed;
  }

  /** Pin a model (never auto-unload). */
  pin(name: string): void {
    const m = this.loaded.get(name);
    if (m) {
      m.pinned = true;
      this.pinnedModel = name;
    }
  }

  /** Unpin a model. */
  unpin(name: string): void {
    const m = this.loaded.get(name);
    if (m) {
      m.pinned = false;
      if (this.pinnedModel === name) this.pinnedModel = null;
    }
  }

  /** Get all loaded models. */
  getLoaded(): VRAMModel[] {
    return Array.from(this.loaded.values());
  }

  /** Get stats. */
  getStats(): { loaded: number; usedGb: number; availableGb: number; maxGb: number } {
    const usedGb = Array.from(this.loaded.values()).reduce((s, m) => s + m.vramGb, 0);
    return {
      loaded: this.loaded.size,
      usedGb,
      availableGb: this.getAvailableVram(),
      maxGb: this.maxVram,
    };
  }
}

// ── Modality Detector ────────────────────────────────────────────────────────

/**
 * Modality — types of model interaction supported.
 * Inspired by SmarterRouter's modality.py.
 */
export type Modality = "text" | "vision" | "tool-calling" | "embedding";

export interface ModalityDetectResult {
  modality: Modality;
  detectedFeatures: string[];
}

/**
 * Detect the modality of an incoming request from its shape.
 * Uses lightweight heuristics based on message content and tools.
 */
export function detectModality(request: {
  messages?: Array<
    { role: string; content: unknown } | { role: string; content: Array<{ type: string }> }
  >;
  tools?: unknown[];
  endpoint?: string;
}): ModalityDetectResult {
  const features: string[] = [];

  // Check for tool calling
  if (request.tools && request.tools.length > 0) {
    features.push("tools-present");
    return { modality: "tool-calling", detectedFeatures: features };
  }

  // Check for vision inputs
  if (request.messages) {
    for (const msg of request.messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "image_url" || part.type === "image") {
            features.push("image-content");
            return { modality: "vision", detectedFeatures: features };
          }
        }
      }
    }
  }

  // Check endpoint
  if (request.endpoint?.includes("embedding")) {
    features.push("embedding-endpoint");
    return { modality: "embedding", detectedFeatures: features };
  }

  features.push("text-only");
  return { modality: "text", detectedFeatures: features };
}

// ── Dead Letter Queue ────────────────────────────────────────────────────────

/**
 * DeadLetterQueue — failed task retry management.
 * Inspired by SmarterRouter's dlq.py.
 */

export interface DLQEntry {
  id: string;
  taskName: string;
  payload?: Record<string, unknown>;
  errorMessage: string;
  status: "failed" | "retrying" | "succeeded" | "abandoned";
  attempts: number;
  maxRetries: number;
  nextRetryAt: number;
  createdAt: number;
}

export interface DLQConfig {
  maxRetries?: number;
  retryBaseDelayMs?: number;
  enabled?: boolean;
}

export class DeadLetterQueue {
  private entries = new Map<string, DLQEntry>();
  private idCounter = 0;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly enabled: boolean;

  constructor(config: DLQConfig = {}) {
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 5_000;
    this.enabled = config.enabled ?? true;
  }

  /** Enqueue a failed task. */
  enqueue(
    taskName: string,
    errorMessage: string,
    payload?: Record<string, unknown>,
    maxRetries?: number,
  ): DLQEntry | null {
    if (!this.enabled) return null;

    const id = String(++this.idCounter);
    const now = Date.now();
    const entry: DLQEntry = {
      id,
      taskName,
      payload,
      errorMessage: errorMessage.slice(0, 2000),
      status: "failed",
      attempts: 0,
      maxRetries: maxRetries ?? this.maxRetries,
      nextRetryAt: now + this.retryBaseDelayMs,
      createdAt: now,
    };

    this.entries.set(id, entry);
    return entry;
  }

  /** List entries by status. */
  list(status?: string, limit = 50): DLQEntry[] {
    let entries = Array.from(this.entries.values());
    if (status) {
      entries = entries.filter((e) => e.status === status);
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** Get entries ready for retry. */
  getReadyForRetry(): DLQEntry[] {
    const now = Date.now();
    return this.list("failed").filter((e) => e.attempts < e.maxRetries && e.nextRetryAt <= now);
  }

  /** Mark an entry as retrying. */
  markRetrying(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = "retrying";
      entry.attempts++;
    }
  }

  /** Mark an entry as succeeded. */
  markSucceeded(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = "succeeded";
    }
  }

  /** Mark an entry as failed again (back to failed). */
  markFailed(id: string, error: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = "failed";
      entry.errorMessage = error.slice(0, 2000);
      entry.nextRetryAt = Date.now() + this.retryBaseDelayMs * Math.pow(2, entry.attempts);
    }
  }

  /** Abandon entries that exceeded max retries. */
  abandonExpired(): DLQEntry[] {
    const abandoned: DLQEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "failed" && entry.attempts >= entry.maxRetries) {
        entry.status = "abandoned";
        abandoned.push(entry);
      }
    }
    return abandoned;
  }

  /** Get stats. */
  getStats(): {
    total: number;
    failed: number;
    retrying: number;
    succeeded: number;
    abandoned: number;
  } {
    const entries = Array.from(this.entries.values());
    return {
      total: entries.length,
      failed: entries.filter((e) => e.status === "failed").length,
      retrying: entries.filter((e) => e.status === "retrying").length,
      succeeded: entries.filter((e) => e.status === "succeeded").length,
      abandoned: entries.filter((e) => e.status === "abandoned").length,
    };
  }
}

// ── Model Profiler ───────────────────────────────────────────────────────────

/**
 * ModelProfiler — benchmark scoring for model capabilities.
 * Inspired by SmarterRouter's profiler.py.
 */

export interface ProfileResult {
  modelName: string;
  reasoning: number; // 0-1
  coding: number; // 0-1
  creativity: number; // 0-1
  speed: number; // 0-1 (tokens/sec normalized)
  avgResponseTimeMs: number;
  vision: boolean;
  toolCalling: boolean;
}

export interface ProfilerConfig {
  /** Timeout per benchmark prompt in ms. */
  timeoutMs?: number;
  /** Judge function to score responses. */
  judge?: (prompt: string, response: string) => Promise<number>;
}

const BENCHMARK_PROMPTS = {
  reasoning: [
    "Solve step by step: If a train travels 120km in 2 hours, and then 180km in 3 hours, what is its average speed?",
    "All roses are flowers. Some flowers fade quickly. Therefore, some roses fade quickly. Is this valid?",
  ],
  coding: [
    "Write a function that finds the longest palindromic substring in a string.",
    "Debug this code: function fib(n) { return fib(n-1) + fib(n-2); }",
  ],
  creativity: ["Write a haiku about artificial intelligence.", "Invent a new word and define it."],
};

function defaultJudge(_prompt: string, response: string): number {
  // Simple heuristic: length + structure
  let score = 0;
  score += Math.min(response.length / 100, 30);
  score += /```/.test(response) ? 15 : 0;
  score += /\n/.test(response) ? 10 : 0;
  score += /step|then|because|therefore/i.test(response) ? 20 : 0;
  return Math.min(1, score / 100);
}

export class ModelProfiler {
  private readonly timeoutMs: number;
  private readonly judge: (prompt: string, response: string) => Promise<number>;
  private readonly llmFn: (prompt: string) => Promise<string>;

  constructor(llmFn: (prompt: string) => Promise<string>, config: ProfilerConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.judge = config.judge ?? defaultJudge;
    this.llmFn = llmFn;
  }

  /** Profile a model across all benchmark categories. */
  async profile(modelName: string): Promise<ProfileResult> {
    const startAll = Date.now();

    const reasoning = await this.benchmarkCategory("reasoning");
    const coding = await this.benchmarkCategory("coding");
    const creativity = await this.benchmarkCategory("creativity");

    const avgResponseTime = (Date.now() - startAll) / 3;
    const speed = Math.max(0, 1 - avgResponseTime / 10_000);

    return {
      modelName,
      reasoning,
      coding,
      creativity,
      speed,
      avgResponseTimeMs: avgResponseTime,
      vision: false, // Set via separate vision test
      toolCalling: false, // Set via separate tool-call test
    };
  }

  private async benchmarkCategory(category: keyof typeof BENCHMARK_PROMPTS): Promise<number> {
    const prompts = BENCHMARK_PROMPTS[category];
    let totalScore = 0;

    for (const prompt of prompts) {
      try {
        const response = await Promise.race([
          this.llmFn(prompt),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), this.timeoutMs),
          ),
        ]);
        const score = await this.judge(prompt, response);
        totalScore += score;
      } catch {
        // Timeout or error — score 0
      }
    }

    return totalScore / prompts.length;
  }
}
