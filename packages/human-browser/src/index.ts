// SPDX-License-Identifier: Apache-2.0
/**
 * human-browser — Human-like mouse/keyboard/scroll simulation layer.
 *
 * Provides:
 *   • HumanTiming       — anti-detection timing utilities
 *   • MouseSimulator    — jittered cursor movement and click recording
 *   • KeyboardSimulator — WPM-based typing with error injection
 *   • ScrollSimulator   — chunked scroll with momentum
 *   • BrowserSession    — records a full sequence of actions
 *   • ActionPlayer      — replays recorded actions (injectable executor)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionType = "move" | "click" | "type" | "scroll" | "wait" | "focus" | "blur";

/** Point interface definition. */
export interface Point { x: number; y: number; }

/** Browser action interface definition. */
export interface BrowserAction {
  type: ActionType;
  payload: Record<string, unknown>;
  delayMs: number;
  timestamp: number;
}

// ── HumanTiming ───────────────────────────────────────────────────────────────

export interface TimingOptions {
  minMs?: number;
  maxMs?: number;
  /** Jitter factor 0–1 applied on top of the base delay. Default 0.3 */
  jitter?: number;
}

/** Human timing. */
export class HumanTiming {
  /**
   * Return a human-like delay between minMs and maxMs with optional jitter.
   * All randomness is seeded from Math.random (injectable for tests).
   */
  static delay(opts: TimingOptions = {}, rng: () => number = Math.random): number {
    const min = opts.minMs ?? 80;
    const max = opts.maxMs ?? 300;
    const jitter = opts.jitter ?? 0.3;
    const base = min + rng() * (max - min);
    const noise = base * jitter * (rng() - 0.5) * 2;
    return Math.max(0, Math.round(base + noise));
  }

  /** Typing delay based on WPM (average 5 chars/word). */
  static typingDelay(wpm = 60, rng: () => number = Math.random): number {
    const msPerChar = 60_000 / (wpm * 5);
    const jitter = msPerChar * 0.4 * (rng() - 0.5) * 2;
    return Math.max(10, Math.round(msPerChar + jitter));
  }

  /** Random chance to make a typo (default 2% per character). */
  static shouldMakeMistake(errorRate = 0.02, rng: () => number = Math.random): boolean {
    return rng() < errorRate;
  }
}

// ── MouseSimulator ────────────────────────────────────────────────────────────

export interface MouseMove {
  from: Point;
  to: Point;
  steps: Point[];
  durationMs: number;
}

/** Mouse simulator. */
export class MouseSimulator {
  private rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  /** Generate a curved path from `from` to `to` with `steps` intermediate points. */
  generatePath(from: Point, to: Point, steps = 10): MouseMove {
    const points: Point[] = [from];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      // Cubic bezier-like curve with random control point offset
      const midX = from.x + (to.x - from.x) * t;
      const midY = from.y + (to.y - from.y) * t;
      const jX = (this.rng() - 0.5) * 20;
      const jY = (this.rng() - 0.5) * 20;
      points.push({ x: Math.round(midX + jX), y: Math.round(midY + jY) });
    }
    points.push(to);
    const durationMs = HumanTiming.delay({ minMs: 200, maxMs: 800 }, this.rng);
    return { from, to, steps: points, durationMs };
  }

  /** Record a click action at `point`. */
  click(point: Point, button: "left" | "right" | "middle" = "left"): BrowserAction {
    return {
      type: "click",
      payload: { x: point.x, y: point.y, button },
      delayMs: HumanTiming.delay({ minMs: 50, maxMs: 150 }, this.rng),
      timestamp: Date.now(),
    };
  }

  /** Convert a mouse path into a sequence of move actions. */
  pathToActions(path: MouseMove): BrowserAction[] {
    const stepDelay = Math.round(path.durationMs / path.steps.length);
    return path.steps.map((pt) => ({
      type: "move",
      payload: { x: pt.x, y: pt.y },
      delayMs: stepDelay,
      timestamp: Date.now(),
    }));
  }
}

// ── KeyboardSimulator ─────────────────────────────────────────────────────────

export interface TypingResult {
  actions: BrowserAction[];
  typed: string;
  errors: number;
}

/** Keyboard simulator. */
export class KeyboardSimulator {
  private rng: () => number;
  private wpm: number;
  private errorRate: number;

  constructor(opts: { wpm?: number; errorRate?: number; rng?: () => number } = {}) {
    this.wpm = opts.wpm ?? 60;
    this.errorRate = opts.errorRate ?? 0.02;
    this.rng = opts.rng ?? Math.random;
  }

  type(text: string): TypingResult {
    const actions: BrowserAction[] = [];
    let typed = "";
    let errors = 0;

    for (const char of text) {
      if (HumanTiming.shouldMakeMistake(this.errorRate, this.rng)) {
        // Type a wrong char then backspace
        const wrongChar = String.fromCharCode(97 + Math.floor(this.rng() * 26));
        actions.push(this._keyAction(wrongChar));
        actions.push(this._keyAction("Backspace", true));
        errors++;
      }
      actions.push(this._keyAction(char));
      typed += char;
    }
    return { actions, typed, errors };
  }

  private _keyAction(key: string, isBackspace = false): BrowserAction {
    return {
      type: "type",
      payload: { key, isBackspace },
      delayMs: HumanTiming.typingDelay(this.wpm, this.rng),
      timestamp: Date.now(),
    };
  }

  /** Type a keyboard shortcut (no timing jitter). */
  shortcut(keys: string[]): BrowserAction {
    return {
      type: "type",
      payload: { keys, shortcut: true },
      delayMs: 50,
      timestamp: Date.now(),
    };
  }
}

// ── ScrollSimulator ───────────────────────────────────────────────────────────

export interface ScrollChunk {
  deltaY: number;
  delayMs: number;
}

/** Scroll simulator. */
export class ScrollSimulator {
  private rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  /** Decompose a total scroll amount into human-like chunks. */
  generateChunks(totalDelta: number, chunkSize = 120): ScrollChunk[] {
    const chunks: ScrollChunk[] = [];
    let remaining = Math.abs(totalDelta);
    const sign = totalDelta >= 0 ? 1 : -1;

    while (remaining > 0) {
      const chunk = Math.min(remaining, chunkSize + Math.round((this.rng() - 0.5) * chunkSize * 0.3));
      chunks.push({
        deltaY: sign * chunk,
        delayMs: HumanTiming.delay({ minMs: 40, maxMs: 120 }, this.rng),
      });
      remaining -= chunk;
    }

    return chunks;
  }

  /** Convert scroll chunks to browser actions. */
  toActions(chunks: ScrollChunk[]): BrowserAction[] {
    return chunks.map((c) => ({
      type: "scroll",
      payload: { deltaY: c.deltaY },
      delayMs: c.delayMs,
      timestamp: Date.now(),
    }));
  }
}

// ── BrowserSession ────────────────────────────────────────────────────────────

export class BrowserSession {
  private actions: BrowserAction[] = [];
  private mouse: MouseSimulator;
  private keyboard: KeyboardSimulator;
  private scrollSim: ScrollSimulator;

  constructor(rng: () => number = Math.random) {
    this.mouse = new MouseSimulator(rng);
    this.keyboard = new KeyboardSimulator({ rng });
    this.scrollSim = new ScrollSimulator(rng);
  }

  moveTo(from: Point, to: Point): this {
    const path = this.mouse.generatePath(from, to);
    this.actions.push(...this.mouse.pathToActions(path));
    return this;
  }

  click(point: Point, button?: "left" | "right" | "middle"): this {
    this.actions.push(this.mouse.click(point, button));
    return this;
  }

  type(text: string): this {
    const result = this.keyboard.type(text);
    this.actions.push(...result.actions);
    return this;
  }

  scroll(totalDelta: number): this {
    const chunks = this.scrollSim.generateChunks(totalDelta);
    this.actions.push(...this.scrollSim.toActions(chunks));
    return this;
  }

  wait(minMs: number, maxMs: number, rng: () => number = Math.random): this {
    this.actions.push({
      type: "wait",
      payload: { minMs, maxMs },
      delayMs: minMs + Math.round(rng() * (maxMs - minMs)),
      timestamp: Date.now(),
    });
    return this;
  }

  getActions(): BrowserAction[] { return [...this.actions]; }

  totalDuration(): number {
    return this.actions.reduce((sum, a) => sum + a.delayMs, 0);
  }

  clear(): this {
    this.actions = [];
    return this;
  }
}

// ── ActionPlayer ──────────────────────────────────────────────────────────────

export type ExecutorFn = (action: BrowserAction) => Promise<void> | void;

/** Playback result interface definition. */
export interface PlaybackResult {
  total: number;
  executed: number;
  errors: number;
  durationMs: number;
}

/** Action player. */
export class ActionPlayer {
  private executor: ExecutorFn;

  constructor(executor: ExecutorFn) {
    this.executor = executor;
  }

  async play(actions: BrowserAction[]): Promise<PlaybackResult> {
    const t0 = Date.now();
    let executed = 0;
    let errors = 0;

    for (const action of actions) {
      try {
        await this.executor(action);
        executed++;
      } catch {
        errors++;
      }
    }

    return { total: actions.length, executed, errors, durationMs: Date.now() - t0 };
  }
}
