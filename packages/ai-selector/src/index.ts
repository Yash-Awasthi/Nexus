// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/ai-selector — AI-powered element finding for web scraping.
 *
 * When CSS/XPath selectors break due to site redesigns, this package
 * falls back to an LLM to locate elements from natural language descriptions.
 *
 * IAISelector      — core interface.
 *
 * LLMAISelector    — sends a truncated HTML snippet + description to an LLM
 *                    and parses structured JSON selector output.
 *                    Supports CSS, XPath, and text-match strategies.
 *                    Injectable LLMProvider (compatible with @nexus/llm-router).
 *
 * NullAISelector   — always returns an empty result; for tests/mocking.
 *
 * CascadeSelector  — tries a list of static selectors first; falls back to AI
 *                    only when all static selectors produce no match indication.
 *
 * HTML truncation
 * ───────────────
 * Raw HTML is truncated to `maxHtmlChars` (default: 8000) before sending to
 * the LLM to avoid blowing the context window.
 * truncateHtml() strips script/style tags and collapses whitespace first.
 *
 * Prompt format
 * ─────────────
 * A structured prompt asks the LLM to return JSON:
 *   { "selector": "...", "strategy": "css"|"xpath"|"text", "confidence": 0-1, "explanation": "..." }
 *
 * Multiple results are requested via findAll() which asks for a JSON array.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SelectorStrategy = "css" | "xpath" | "text";

/** Selector example interface definition. */
export interface SelectorExample {
  description: string;
  selector: string;
  strategy: SelectorStrategy;
}

/** Element selector request interface definition. */
export interface ElementSelectorRequest {
  /** Raw HTML of the page or relevant section. Will be truncated if too long. */
  html: string;
  /** Natural language description of the target element. */
  description: string;
  /** Preferred selector output strategy. Default: "css" */
  preferredStrategy?: SelectorStrategy;
  /** Few-shot examples to guide the model. */
  examples?: SelectorExample[];
  /** Hint: what the element is used for (e.g. "price", "add-to-cart button"). */
  hint?: string;
}

/** Element selector result interface definition. */
export interface ElementSelectorResult {
  selector: string;
  strategy: SelectorStrategy;
  /** 0–1 confidence estimate from the model. */
  confidence: number;
  explanation?: string;
}

// ── IAISelector ───────────────────────────────────────────────────────────────

export interface IAISelector {
  /**
   * Find the single best selector for the described element.
   * Returns undefined if the model cannot locate it.
   */
  find(request: ElementSelectorRequest): Promise<ElementSelectorResult | undefined>;

  /**
   * Find multiple candidate selectors, ordered by confidence descending.
   * Returns empty array on failure.
   */
  findAll(request: ElementSelectorRequest): Promise<ElementSelectorResult[]>;
}

// ── Error ──────────────────────────────────────────────────────────────────────

export class AISelectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AISelectorError";
  }
}

// ── LLMProvider interface (minimal, compatible with @nexus/llm-router) ────────

export type MessageRole = "system" | "user" | "assistant";

/** Llm message interface definition. */
export interface LLMMessage {
  role: MessageRole;
  content: string;
}

/** Llm request interface definition. */
export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
}

/** Llm response interface definition. */
export interface LLMResponse {
  content: string;
}

/** Llm provider interface definition. */
export interface LLMProvider {
  readonly name: string;
  readonly models: readonly string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
}

// ── HTML utilities ────────────────────────────────────────────────────────────

/**
 * Strip script/style blocks, collapse whitespace, and truncate to maxChars.
 */
export function truncateHtml(html: string, maxChars = 8000): string {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars) + "…[truncated]";
  }
  return cleaned;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildFindPrompt(req: ElementSelectorRequest, html: string): string {
  const strategy = req.preferredStrategy ?? "css";
  const examples =
    req.examples && req.examples.length > 0
      ? "\n\nExamples:\n" +
        req.examples
          .map(
            (e) => `- Description: "${e.description}"\n  Selector: ${e.selector} (${e.strategy})`,
          )
          .join("\n")
      : "";

  return `You are an expert web scraper. Given the HTML below, find the ${strategy} selector for the described element.

Element description: ${req.description}${req.hint ? `\nHint: ${req.hint}` : ""}${examples}

HTML:
${html}

Return ONLY valid JSON (no markdown, no code fences) in this exact shape:
{"selector":"<selector>","strategy":"${strategy}","confidence":<0.0-1.0>,"explanation":"<brief reason>"}

If you cannot locate the element, return:
{"selector":"","strategy":"${strategy}","confidence":0,"explanation":"Element not found"}`;
}

function buildFindAllPrompt(req: ElementSelectorRequest, html: string): string {
  const strategy = req.preferredStrategy ?? "css";

  return `You are an expert web scraper. Given the HTML below, find up to 5 candidate selectors for the described element, ordered by confidence.

Element description: ${req.description}${req.hint ? `\nHint: ${req.hint}` : ""}

HTML:
${html}

Return ONLY a valid JSON array (no markdown, no code fences):
[{"selector":"<selector>","strategy":"css|xpath|text","confidence":<0.0-1.0>,"explanation":"<brief reason>"},...]

Preferred strategy: ${strategy}. If no candidates found, return [].`;
}

// ── JSON parsers ──────────────────────────────────────────────────────────────

function parseSingle(raw: string): ElementSelectorResult | undefined {
  try {
    // Extract first JSON object from response
    const match = /\{[\s\S]*?\}/.exec(raw);
    if (!match) return undefined;
    const parsed = JSON.parse(match[0]) as Partial<ElementSelectorResult>;
    if (!parsed.selector || parsed.confidence === 0) return undefined;
    return {
      selector: parsed.selector,
      strategy: (parsed.strategy!) ?? "css",
      confidence: parsed.confidence ?? 0,
      explanation: parsed.explanation,
    };
  } catch {
    return undefined;
  }
}

function parseMultiple(raw: string): ElementSelectorResult[] {
  try {
    const match = /\[[\s\S]*?\]/.exec(raw);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as Partial<ElementSelectorResult>[];
    return parsed
      .filter((r) => r.selector && (r.confidence ?? 0) > 0)
      .map((r) => ({
        selector: r.selector!,
        strategy: (r.strategy!) ?? "css",
        confidence: r.confidence ?? 0,
        explanation: r.explanation,
      }))
      .sort((a, b) => b.confidence - a.confidence);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMAISelector
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMAISelectorConfig {
  model: string;
  maxHtmlChars?: number;
  maxTokens?: number;
  /** Temperature — low for deterministic selector output. Default: 0.1 */
  temperature?: number;
}

/** Llmai selector. */
export class LLMAISelector implements IAISelector {
  private readonly maxHtmlChars: number;

  constructor(
    private readonly llm: LLMProvider,
    private readonly config: LLMAISelectorConfig,
  ) {
    this.maxHtmlChars = config.maxHtmlChars ?? 8000;
  }

  async find(request: ElementSelectorRequest): Promise<ElementSelectorResult | undefined> {
    const html = truncateHtml(request.html, this.maxHtmlChars);
    const prompt = buildFindPrompt(request, html);

    const response = await this.llm.complete({
      model: this.config.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: this.config.maxTokens ?? 512,
      temperature: this.config.temperature ?? 0.1,
    });

    return parseSingle(response.content);
  }

  async findAll(request: ElementSelectorRequest): Promise<ElementSelectorResult[]> {
    const html = truncateHtml(request.html, this.maxHtmlChars);
    const prompt = buildFindAllPrompt(request, html);

    const response = await this.llm.complete({
      model: this.config.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: this.config.maxTokens ?? 1024,
      temperature: this.config.temperature ?? 0.1,
    });

    return parseMultiple(response.content);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NullAISelector
// ─────────────────────────────────────────────────────────────────────────────

/** Always returns no results. Useful as a disabled fallback in tests. */
export class NullAISelector implements IAISelector {
  async find(): Promise<ElementSelectorResult | undefined> {
    return undefined;
  }
  async findAll(): Promise<ElementSelectorResult[]> {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CascadeSelector
// ─────────────────────────────────────────────────────────────────────────────

export interface StaticSelector {
  selector: string;
  strategy: SelectorStrategy;
  description?: string;
}

/** Cascade selector config interface definition. */
export interface CascadeSelectorConfig {
  /** Static selectors to try first. */
  statics: StaticSelector[];
  /** AI fallback if all statics fail the validator. */
  ai: IAISelector;
  /**
   * Validate whether a static selector "works" against the given HTML.
   * Default: checks whether the selector string is present in the HTML (naive).
   * Inject a real DOM validator (e.g. using a headless parser) for production.
   */
  validate?: (selector: StaticSelector, html: string) => boolean;
}

/**
 * Tries static selectors first; falls back to AI when all fail validation.
 */
export class CascadeSelector implements IAISelector {
  private readonly validate: (sel: StaticSelector, html: string) => boolean;

  constructor(private readonly config: CascadeSelectorConfig) {
    this.validate =
      config.validate ??
      // Default naive validator: check if any attribute value or class name
      // approximating the selector exists in the raw HTML.
      ((sel, html) =>
        html.includes(sel.selector.replace(/[.#[\]>+~*:^$|]/g, "").split(" ")[0] ?? ""));
  }

  async find(request: ElementSelectorRequest): Promise<ElementSelectorResult | undefined> {
    for (const s of this.config.statics) {
      if (this.validate(s, request.html)) {
        return { selector: s.selector, strategy: s.strategy, confidence: 1.0 };
      }
    }
    return this.config.ai.find(request);
  }

  async findAll(request: ElementSelectorRequest): Promise<ElementSelectorResult[]> {
    const staticResults: ElementSelectorResult[] = [];
    for (const s of this.config.statics) {
      if (this.validate(s, request.html)) {
        staticResults.push({ selector: s.selector, strategy: s.strategy, confidence: 1.0 });
      }
    }
    if (staticResults.length > 0) return staticResults;
    return this.config.ai.findAll(request);
  }
}
