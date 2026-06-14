// SPDX-License-Identifier: Apache-2.0
/**
 * stm — STM (Style Transformation Module) output transformer pipeline.
 *
 * Transforms LLM output text through a configurable pipeline of rewrite modules
 * (hedge-reducer, directness-optimizer, etc.) before returning to the client.
 *
 * Provides:
 *   • STMModule              — module interface
 *   • STMModuleId            — known module identifiers
 *   • TransformInput/Output  — typed I/O
 *   • applySTMs()            — pipeline executor
 *   • HedgeReducer           — removes hedge phrases
 *   • DirectnessOptimizer    — replaces passive/verbose constructions
 *   • TruncationGuard        — enforces max char limit
 *   • STMRegistry            — module registration + lookup
 *   • STMPipeline            — assembled pipeline with partial-module support
 *   • MockSTMModule          — test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type STMModuleId = string;

export interface TransformContext {
  sessionId?: string;
  userId?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}

export interface TransformInput {
  text: string;
  moduleIds?: STMModuleId[];  // null/undefined → apply all registered
  context?: TransformContext;
  maxChars?: number;          // enforced by TruncationGuard
}

export interface ModuleResult {
  moduleId: STMModuleId;
  before: string;
  after: string;
  changed: boolean;
}

export interface TransformOutput {
  original: string;
  transformed: string;
  modules: ModuleResult[];
  truncated: boolean;
  charCount: number;
}

export interface STMModule {
  id: STMModuleId;
  description: string;
  apply(text: string, ctx?: TransformContext): string;
}

// ── HedgeReducer ─────────────────────────────────────────────────────────────

const HEDGE_PATTERNS: Array<[RegExp, string]> = [
  [/\bIt(?:'s| is) (?:worth noting that|important to note that)\b/gi, ""],
  [/\bIt (?:should|may) be noted that\b/gi, ""],
  [/\bIn (?:many|some) cases[,]?\s*/gi, ""],
  [/\bGenerally speaking[,]?\s*/gi, ""],
  [/\bIt (?:seems|appears) (?:that|to be) /gi, ""],
  [/\bI (?:think|believe|feel) (?:that )?/gi, ""],
  [/\bOne could (?:argue|say) (?:that )?/gi, ""],
  [/\bPerhaps /gi, ""],
  [/\bMaybe /gi, ""],
  [/\bApparently /gi, ""],
];

export class HedgeReducer implements STMModule {
  readonly id = "hedge-reducer";
  readonly description = "Removes hedge phrases to produce more direct statements";

  apply(text: string): string {
    let result = text;
    for (const [pattern, replacement] of HEDGE_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    // Collapse double spaces and fix sentence starts
    return result
      .replace(/\s{2,}/g, " ")
      .replace(/^\s+/gm, "")
      .trim();
  }
}

// ── DirectnessOptimizer ───────────────────────────────────────────────────────

const DIRECTNESS_PATTERNS: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bat this point in time\b/gi, "now"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],
  [/\bwith regard to\b/gi, "regarding"],
  [/\bin the event that\b/gi, "if"],
  [/\bnotwithstanding the fact that\b/gi, "although"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\ba small number of\b/gi, "few"],
  [/\bwith the exception of\b/gi, "except"],
];

export class DirectnessOptimizer implements STMModule {
  readonly id = "directness-optimizer";
  readonly description = "Replaces verbose/passive constructions with direct equivalents";

  apply(text: string): string {
    let result = text;
    for (const [pattern, replacement] of DIRECTNESS_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result.trim();
  }
}

// ── TruncationGuard ───────────────────────────────────────────────────────────

export class TruncationGuard implements STMModule {
  readonly id = "truncation-guard";
  readonly description = "Enforces maximum character limit";

  private maxChars: number;

  constructor(maxChars = 50_000) {
    this.maxChars = maxChars;
  }

  apply(text: string): string {
    return text.length > this.maxChars ? text.slice(0, this.maxChars) : text;
  }

  didTruncate(text: string): boolean {
    return text.length > this.maxChars;
  }

  setMaxChars(n: number): void { this.maxChars = n; }
  getMaxChars(): number { return this.maxChars; }
}

// ── MockSTMModule ─────────────────────────────────────────────────────────────

export class MockSTMModule implements STMModule {
  readonly id: STMModuleId;
  readonly description: string;
  private transform: (text: string) => string;
  readonly calls: string[] = [];

  constructor(id: STMModuleId, transform: (text: string) => string = (t) => t, description = "") {
    this.id = id;
    this.transform = transform;
    this.description = description;
  }

  apply(text: string): string {
    this.calls.push(text);
    return this.transform(text);
  }
}

// ── STMRegistry ───────────────────────────────────────────────────────────────

export class STMRegistry {
  private modules = new Map<STMModuleId, STMModule>();

  register(module: STMModule): this {
    this.modules.set(module.id, module);
    return this;
  }

  get(id: STMModuleId): STMModule | undefined { return this.modules.get(id); }
  has(id: STMModuleId): boolean { return this.modules.has(id); }
  list(): STMModule[] { return [...this.modules.values()]; }
  ids(): STMModuleId[] { return [...this.modules.keys()]; }
  unregister(id: STMModuleId): boolean { return this.modules.delete(id); }
  clear(): void { this.modules.clear(); }
  size(): number { return this.modules.size; }
}

// ── applySTMs ─────────────────────────────────────────────────────────────────

export function applySTMs(
  text: string,
  modules: STMModule[],
  ctx?: TransformContext,
): { text: string; results: ModuleResult[] } {
  let current = text;
  const results: ModuleResult[] = [];

  for (const mod of modules) {
    const before = current;
    current = mod.apply(current, ctx);
    results.push({
      moduleId: mod.id,
      before,
      after: current,
      changed: before !== current,
    });
  }

  return { text: current, results };
}

// ── STMPipeline ───────────────────────────────────────────────────────────────

export class STMPipeline {
  private registry: STMRegistry;
  private truncationGuard: TruncationGuard;

  constructor(registry?: STMRegistry, maxChars = 50_000) {
    this.registry = registry ?? new STMRegistry();
    this.truncationGuard = new TruncationGuard(maxChars);
  }

  transform(input: TransformInput): TransformOutput {
    const MAX_CHARS = input.maxChars ?? this.truncationGuard.getMaxChars();

    // Validate modules exist
    if (input.moduleIds) {
      for (const id of input.moduleIds) {
        if (!this.registry.has(id)) {
          throw new Error(`STM module not found: ${id}`);
        }
      }
    }

    // Determine which modules to apply
    const modules = input.moduleIds
      ? input.moduleIds.map((id) => this.registry.get(id)!)
      : this.registry.list();

    const { text, results } = applySTMs(input.text, modules, input.context);

    // Apply truncation
    const truncated = text.length > MAX_CHARS;
    const finalText = truncated ? text.slice(0, MAX_CHARS) : text;

    return {
      original: input.text,
      transformed: finalText,
      modules: results,
      truncated,
      charCount: finalText.length,
    };
  }

  getRegistry(): STMRegistry { return this.registry; }

  /** Partially apply only specific module IDs (skip missing without error). */
  transformPartial(input: TransformInput): TransformOutput {
    const safeIds = (input.moduleIds ?? this.registry.ids()).filter((id) => this.registry.has(id));
    return this.transform({ ...input, moduleIds: safeIds });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createDefaultPipeline(maxChars = 50_000): STMPipeline {
  const registry = new STMRegistry()
    .register(new HedgeReducer())
    .register(new DirectnessOptimizer());
  return new STMPipeline(registry, maxChars);
}
