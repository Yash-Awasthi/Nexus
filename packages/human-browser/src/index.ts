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
export interface Point {
  x: number;
  y: number;
}

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
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
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
      const chunk = Math.min(
        remaining,
        chunkSize + Math.round((this.rng() - 0.5) * chunkSize * 0.3),
      );
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

  getActions(): BrowserAction[] {
    return [...this.actions];
  }

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

// ── ComputerUseAgent — UI-TARS-inspired screenshot → plan → act loop ──────────
//
// UI-TARS (bytedance-research/UI-TARS-desktop): GUI Agent that observes the
// screen via screenshots, plans actions (click, type, scroll, navigate), and
// executes them. Core loop: observe → think → act → verify.
//
// Integrated with BrowserSession + ActionPlayer from above.

export interface ComputerUseObservation {
  screenshotBase64?: string;
  screenshotPath?: string;
  visibleText?: string;
  url?: string;
  timestamp: string;
}

export interface ComputerUseAction {
  type: "click" | "type" | "scroll" | "navigate" | "wait" | "screenshot";
  target?: string;   // CSS selector or descriptive text
  value?: string;    // text to type or URL to navigate
  x?: number; y?: number;
  scrollDelta?: number;
}

export interface ComputerUseStep {
  observation: ComputerUseObservation;
  reasoning: string;
  action: ComputerUseAction;
  result?: string;
}

export interface ComputerUseResult {
  goal: string;
  steps: ComputerUseStep[];
  success: boolean;
  finalObservation?: ComputerUseObservation;
  timestamp: string;
}

export type ObserveFn = () => Promise<ComputerUseObservation>;
export type ExecuteActionFn = (action: ComputerUseAction) => Promise<string>;
export type PlanFn = (goal: string, observation: ComputerUseObservation, history: ComputerUseStep[]) => Promise<{ reasoning: string; action: ComputerUseAction; done: boolean }>;

export interface ComputerUseAgentOpts {
  observe: ObserveFn;
  execute: ExecuteActionFn;
  plan: PlanFn;
  maxSteps?: number;
  verifySuccess?: (obs: ComputerUseObservation) => boolean;
}

/** Computer use agent — observe → plan → act loop (UI-TARS pattern). */
export class ComputerUseAgent {
  private opts: ComputerUseAgentOpts;

  constructor(opts: ComputerUseAgentOpts) {
    this.opts = opts;
  }

  async run(goal: string): Promise<ComputerUseResult> {
    const maxSteps = this.opts.maxSteps ?? 20;
    const steps: ComputerUseStep[] = [];
    let success = false;
    let finalObservation: ComputerUseObservation | undefined;

    for (let i = 0; i < maxSteps; i++) {
      const observation = await this.opts.observe();
      finalObservation = observation;

      // Check if goal is already achieved
      if (this.opts.verifySuccess?.(observation)) { success = true; break; }

      let plan: { reasoning: string; action: ComputerUseAction; done: boolean };
      try {
        plan = await this.opts.plan(goal, observation, steps);
      } catch {
        break;
      }

      let result: string | undefined;
      if (!plan.done) {
        try {
          result = await this.opts.execute(plan.action);
        } catch (e) {
          result = `Error: ${String(e)}`;
        }
      }

      steps.push({ observation, reasoning: plan.reasoning, action: plan.action, result });

      if (plan.done) { success = !steps.some((s) => s.result?.startsWith("Error:")); break; }
    }

    return { goal, steps, success, finalObservation, timestamp: new Date().toISOString() };
  }
}

// ── ScreenObserver — screenshot capture and element location helper ────────────

export interface ScreenElement {
  selector: string;
  text?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export type ScreenshotFn = () => Promise<string>; // returns base64 or path
export type FindElementFn = (selector: string) => Promise<ScreenElement | null>;

/** Screen observer */
export class ScreenObserver {
  private screenshotFn: ScreenshotFn;
  private findFn: FindElementFn;

  constructor(screenshotFn: ScreenshotFn, findFn: FindElementFn) {
    this.screenshotFn = screenshotFn;
    this.findFn = findFn;
  }

  async observe(url?: string): Promise<ComputerUseObservation> {
    const screenshotBase64 = await this.screenshotFn().catch(() => undefined);
    return { screenshotBase64, url, timestamp: new Date().toISOString() };
  }

  async findElement(selector: string): Promise<ScreenElement | null> {
    return this.findFn(selector).catch(() => null);
  }

  async findElements(selectors: string[]): Promise<ScreenElement[]> {
    const results = await Promise.allSettled(selectors.map((s) => this.findFn(s)));
    return results.flatMap((r) => r.status === "fulfilled" && r.value ? [r.value] : []);
  }
}

// ── Human Input Simulation (from CloakBrowser audit) ─────────────────────────
//
// Framework-agnostic human-like mouse, keyboard, and scroll primitives.
// Uses injectable RawMouse/RawKeyboard interfaces so they work with any
// Playwright-compatible driver without importing playwright directly.
// Extracted from CloakBrowser (MIT) — ported to @nexus/human-browser.

// ── Config ────────────────────────────────────────────────────────────────────

export interface HumanConfig {
  // Keyboard
  typing_delay: number;
  typing_delay_spread: number;
  typing_pause_chance: number;
  typing_pause_range: [number, number];
  shift_down_delay: [number, number];
  shift_up_delay: [number, number];
  key_hold: [number, number];
  field_switch_delay: [number, number];
  mistype_chance: number;
  mistype_delay_notice: [number, number];
  mistype_delay_correct: [number, number];
  // Mouse — movement
  mouse_steps_divisor: number;
  mouse_min_steps: number;
  mouse_max_steps: number;
  mouse_wobble_max: number;
  mouse_overshoot_chance: number;
  mouse_overshoot_px: [number, number];
  mouse_burst_size: [number, number];
  mouse_burst_pause: [number, number];
  // Mouse — clicks
  click_aim_delay_input: [number, number];
  click_aim_delay_button: [number, number];
  click_hold_input: [number, number];
  click_hold_button: [number, number];
  click_input_x_range: [number, number];
  // Mouse — idle
  idle_drift_px: number;
  idle_pause_range: [number, number];
  // Scroll
  scroll_delta_base: [number, number];
  scroll_delta_variance: number;
  scroll_pause_fast: [number, number];
  scroll_pause_slow: [number, number];
  scroll_accel_steps: [number, number];
  scroll_decel_steps: [number, number];
  scroll_overshoot_chance: number;
  scroll_overshoot_px: [number, number];
  scroll_settle_delay: [number, number];
  scroll_target_zone: [number, number];
  scroll_pre_move_delay: [number, number];
  initial_cursor_x: [number, number];
  initial_cursor_y: [number, number];
  idle_between_actions: boolean;
  idle_between_duration: [number, number];
}

export type HumanPreset = "default" | "careful";

const _HUMAN_DEFAULT: HumanConfig = {
  typing_delay: 70, typing_delay_spread: 40, typing_pause_chance: 0.1,
  typing_pause_range: [400, 1000], shift_down_delay: [30, 70], shift_up_delay: [20, 50],
  key_hold: [15, 35], field_switch_delay: [800, 1500],
  mistype_chance: 0.02, mistype_delay_notice: [100, 300], mistype_delay_correct: [50, 150],
  mouse_steps_divisor: 8, mouse_min_steps: 25, mouse_max_steps: 80, mouse_wobble_max: 1.5,
  mouse_overshoot_chance: 0.15, mouse_overshoot_px: [3, 6],
  mouse_burst_size: [3, 5], mouse_burst_pause: [8, 18],
  click_aim_delay_input: [60, 140], click_aim_delay_button: [80, 200],
  click_hold_input: [40, 100], click_hold_button: [60, 150],
  click_input_x_range: [0.05, 0.30], idle_drift_px: 3, idle_pause_range: [300, 1000],
  scroll_delta_base: [80, 130], scroll_delta_variance: 0.2,
  scroll_pause_fast: [30, 80], scroll_pause_slow: [80, 200],
  scroll_accel_steps: [2, 3], scroll_decel_steps: [2, 3],
  scroll_overshoot_chance: 0.1, scroll_overshoot_px: [50, 150],
  scroll_settle_delay: [300, 600], scroll_target_zone: [0.20, 0.80],
  scroll_pre_move_delay: [100, 300], initial_cursor_x: [400, 700],
  initial_cursor_y: [45, 60], idle_between_actions: false, idle_between_duration: [0.3, 0.8],
};

const _HUMAN_CAREFUL: HumanConfig = {
  ..._HUMAN_DEFAULT,
  typing_delay: 100, typing_delay_spread: 50, typing_pause_chance: 0.15,
  typing_pause_range: [500, 1200], shift_down_delay: [40, 90], shift_up_delay: [30, 70],
  key_hold: [20, 45], field_switch_delay: [1000, 2000],
  mistype_chance: 0.03, mistype_delay_notice: [150, 400], mistype_delay_correct: [80, 200],
  mouse_overshoot_chance: 0.10, mouse_burst_pause: [12, 25],
  click_aim_delay_input: [80, 180], click_aim_delay_button: [120, 280],
  click_hold_input: [60, 140], click_hold_button: [80, 200],
  scroll_pause_fast: [100, 200], scroll_pause_slow: [250, 600],
  scroll_settle_delay: [400, 800], scroll_pre_move_delay: [150, 400],
  idle_between_actions: true, idle_between_duration: [0.4, 1.0],
};

export function resolveHumanConfig(
  preset: HumanPreset = "default",
  overrides?: Partial<HumanConfig>,
): HumanConfig {
  const base = preset === "careful" ? _HUMAN_CAREFUL : _HUMAN_DEFAULT;
  return overrides ? { ...base, ...overrides } : { ...base };
}

function _hRand(min: number, max: number): number { return min + Math.random() * (max - min); }
function _hRandRange(r: [number, number]): number { return _hRand(r[0], r[1]); }
function _hRandInt(min: number, max: number): number { return Math.floor(_hRand(min, max + 1)); }
function _hRandIntRange(r: [number, number]): number { return _hRandInt(r[0], r[1]); }
function _hSleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── Raw interfaces (injectable — no Playwright import needed) ──────────────

export interface HumanRawMouse {
  move(x: number, y: number): Promise<void>;
  down(opts?: unknown): Promise<void>;
  up(opts?: unknown): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface HumanRawKeyboard {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  type(text: string): Promise<void>;
  insertText(text: string): Promise<void>;
}

// ── Mouse ─────────────────────────────────────────────────────────────────────

interface _Pt { x: number; y: number; }

function _bezier(p0: _Pt, p1: _Pt, p2: _Pt, p3: _Pt, t: number): _Pt {
  const u = 1 - t, uu = u * u, uuu = uu * u, tt = t * t, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

function _easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function _randomCPs(s: _Pt, e: _Pt): [_Pt, _Pt] {
  const dx = e.x - s.x, dy = e.y - s.y, dist = Math.hypot(dx, dy) || 1;
  const px = -dy / dist, py = dx / dist;
  const b1 = _hRand(-0.3, 0.3) * dist, b2 = _hRand(-0.3, 0.3) * dist;
  return [
    { x: s.x + dx * 0.25 + px * b1, y: s.y + dy * 0.25 + py * b1 },
    { x: s.x + dx * 0.75 + px * b2, y: s.y + dy * 0.75 + py * b2 },
  ];
}

/** Move mouse along a cubic Bézier path with easeInOut and wobble. */
export async function humanMove(
  raw: HumanRawMouse,
  sx: number, sy: number, ex: number, ey: number,
  cfg: HumanConfig,
): Promise<void> {
  const dist = Math.hypot(ex - sx, ey - sy);
  if (dist < 1) return;
  const steps = Math.max(cfg.mouse_min_steps,
    Math.min(cfg.mouse_max_steps, Math.round(dist / cfg.mouse_steps_divisor)));
  const s: _Pt = { x: sx, y: sy }, e: _Pt = { x: ex, y: ey };
  const [cp1, cp2] = _randomCPs(s, e);
  let burst = 0, burstSz = _hRandIntRange(cfg.mouse_burst_size);
  for (let i = 0; i <= steps; i++) {
    const pt = _bezier(s, cp1, cp2, e, _easeInOut(i / steps));
    const w = Math.sin(Math.PI * i / steps) * cfg.mouse_wobble_max;
    await raw.move(Math.round(pt.x + (Math.random() - 0.5) * 2 * w),
      Math.round(pt.y + (Math.random() - 0.5) * 2 * w));
    if (++burst >= burstSz && i < steps) { await _hSleep(_hRandRange(cfg.mouse_burst_pause)); burst = 0; }
  }
  if (Math.random() < cfg.mouse_overshoot_chance) {
    const od = _hRandRange(cfg.mouse_overshoot_px), angle = Math.atan2(ey - sy, ex - sx);
    await raw.move(Math.round(ex + Math.cos(angle) * od), Math.round(ey + Math.sin(angle) * od));
    await _hSleep(_hRand(30, 70));
    await raw.move(Math.round(ex + (Math.random() - 0.5) * 4), Math.round(ey + (Math.random() - 0.5) * 4));
  }
}

/** Human-like click with aim delay and variable hold duration. */
export async function humanClick(
  raw: HumanRawMouse, isInput: boolean, cfg: HumanConfig,
): Promise<void> {
  await _hSleep(isInput ? _hRandRange(cfg.click_aim_delay_input) : _hRandRange(cfg.click_aim_delay_button));
  await raw.down();
  await _hSleep(isInput ? _hRandRange(cfg.click_hold_input) : _hRandRange(cfg.click_hold_button));
  await raw.up();
}

/** Idle mouse drift around a center point. */
export async function humanIdle(
  raw: HumanRawMouse, cx: number, cy: number,
  cfg: HumanConfig, seconds?: number,
): Promise<void> {
  const dur = seconds ?? _hRand(cfg.idle_between_duration[0], cfg.idle_between_duration[1]);
  const end = Date.now() + dur * 1000;
  let x = cx, y = cy;
  while (Date.now() < end) {
    x += (Math.random() - 0.5) * 2 * cfg.idle_drift_px;
    y += (Math.random() - 0.5) * 2 * cfg.idle_drift_px;
    await raw.move(Math.round(x), Math.round(y));
    await _hSleep(_hRandRange(cfg.idle_pause_range));
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const _NEARBY_KEYS: Record<string, string> = {
  a:"sqwz",b:"vghn",c:"xdfv",d:"sfecx",e:"wrsdf",f:"dgrtcv",g:"fhtyb",h:"gjybn",i:"ujko",
  j:"hkunm",k:"jloi",l:"kop",m:"njk",n:"bhjm",o:"iklp",p:"ol",q:"wa",r:"edft",s:"awedxz",
  t:"rfgy",u:"yhji",v:"cfgb",w:"qase",x:"zsdc",y:"tghu",z:"asx",
  "1":"2q","2":"13qw","3":"24we","4":"35er","5":"46rt",
  "6":"57ty","7":"68yu","8":"79ui","9":"80io","0":"9p",
};

function _nearbyKey(ch: string): string {
  const n = _NEARBY_KEYS[ch.toLowerCase()];
  if (!n) return ch;
  const w = n[Math.floor(Math.random() * n.length)];
  return ch !== ch.toLowerCase() ? w.toUpperCase() : w;
}

/** Type text with WPM-variance timing, mistype simulation, and per-char rhythm. */
export async function humanType(
  raw: HumanRawKeyboard, text: string, cfg: HumanConfig,
): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const ascii = (ch.codePointAt(0) ?? 0) < 128;
    if (!ascii) {
      await _hSleep(_hRandRange(cfg.key_hold));
      await raw.insertText(ch);
    } else {
      if (Math.random() < cfg.mistype_chance && /^[a-zA-Z0-9]$/.test(ch)) {
        const wrong = _nearbyKey(ch);
        await raw.down(wrong); await _hSleep(_hRandRange(cfg.key_hold)); await raw.up(wrong);
        await _hSleep(_hRandRange(cfg.mistype_delay_notice));
        await raw.down("Backspace"); await _hSleep(_hRandRange(cfg.key_hold)); await raw.up("Backspace");
        await _hSleep(_hRandRange(cfg.mistype_delay_correct));
      }
      const upper = ch >= "A" && ch <= "Z";
      if (upper) { await raw.down("Shift"); await _hSleep(_hRandRange(cfg.shift_down_delay)); }
      await raw.down(ch); await _hSleep(_hRandRange(cfg.key_hold)); await raw.up(ch);
      if (upper) { await _hSleep(_hRandRange(cfg.shift_up_delay)); await raw.up("Shift"); }
    }
    if (i < text.length - 1) {
      if (Math.random() < cfg.typing_pause_chance) {
        await _hSleep(_hRandRange(cfg.typing_pause_range));
      } else {
        await _hSleep(Math.max(10, cfg.typing_delay + (Math.random() - 0.5) * 2 * cfg.typing_delay_spread));
      }
    }
  }
}

// ── Scroll ────────────────────────────────────────────────────────────────────

async function _smoothWheel(raw: HumanRawMouse, delta: number, cfg: HumanConfig): Promise<void> {
  const abs = Math.abs(delta), sign = delta > 0 ? 1 : -1;
  let sent = 0;
  while (sent < abs) {
    const chunk = Math.min(_hRand(20, 40), abs - sent);
    await raw.wheel(0, Math.round(chunk) * sign);
    sent += chunk;
    await _hSleep(_hRand(8, 20));
  }
}

export interface ScrollViewport { width: number; height: number; }

/** Accelerate → cruise → decelerate scroll with optional overshoot correction. */
export async function humanScroll(
  raw: HumanRawMouse,
  distancePx: number,
  cfg: HumanConfig,
): Promise<void> {
  const dir = distancePx > 0 ? 1 : -1;
  const abs = Math.abs(distancePx);
  const avg = (cfg.scroll_delta_base[0] + cfg.scroll_delta_base[1]) / 2;
  const clicks = Math.max(3, Math.ceil(abs / avg));
  const accel = _hRandIntRange(cfg.scroll_accel_steps);
  const decel = _hRandIntRange(cfg.scroll_decel_steps);
  let scrolled = 0;
  for (let i = 0; i < clicks; i++) {
    let delta: number, pause: number;
    if (i < accel) { delta = _hRand(80, 100); pause = _hRandRange(cfg.scroll_pause_slow); }
    else if (i >= clicks - decel) { delta = _hRand(60, 90); pause = _hRandRange(cfg.scroll_pause_slow); }
    else { delta = _hRandRange(cfg.scroll_delta_base); pause = _hRandRange(cfg.scroll_pause_fast); }
    delta *= 1 + (Math.random() - 0.5) * 2 * cfg.scroll_delta_variance;
    await _smoothWheel(raw, Math.round(delta) * dir, cfg);
    scrolled += Math.abs(delta);
    await _hSleep(pause);
    if (scrolled >= abs * 1.1) break;
  }
  if (Math.random() < cfg.scroll_overshoot_chance) {
    const ov = Math.round(_hRandRange(cfg.scroll_overshoot_px)) * dir;
    await _smoothWheel(raw, ov, cfg);
    await _hSleep(_hRandRange(cfg.scroll_settle_delay));
    for (let c = 0; c < _hRandInt(1, 2); c++) {
      await _smoothWheel(raw, Math.round(_hRand(40, 80)) * -dir, cfg);
      await _hSleep(_hRand(100, 250));
    }
  }
  await _hSleep(_hRandRange(cfg.scroll_settle_delay));
}

// ── GeoIP fingerprint helpers ─────────────────────────────────────────────────

/** ISO-3166 alpha-2 country → BCP-47 locale. Covers ~90% of proxy traffic. */
export const COUNTRY_LOCALE_MAP: Record<string, string> = {
  US:"en-US",GB:"en-GB",AU:"en-AU",CA:"en-CA",NZ:"en-NZ",IE:"en-IE",ZA:"en-ZA",SG:"en-SG",
  DE:"de-DE",AT:"de-AT",CH:"de-CH",FR:"fr-FR",BE:"fr-BE",
  ES:"es-ES",MX:"es-MX",AR:"es-AR",CO:"es-CO",CL:"es-CL",
  BR:"pt-BR",PT:"pt-PT",IT:"it-IT",NL:"nl-NL",
  JP:"ja-JP",KR:"ko-KR",CN:"zh-CN",TW:"zh-TW",HK:"zh-HK",
  RU:"ru-RU",UA:"uk-UA",PL:"pl-PL",CZ:"cs-CZ",RO:"ro-RO",
  IL:"he-IL",TR:"tr-TR",SA:"ar-SA",AE:"ar-AE",EG:"ar-EG",
  IN:"hi-IN",ID:"id-ID",PH:"en-PH",TH:"th-TH",VN:"vi-VN",MY:"ms-MY",
};

/** Resolve BCP-47 locale from ISO country code. Falls back to "en-US". */
export function countryToLocale(countryCode: string): string {
  return COUNTRY_LOCALE_MAP[countryCode.toUpperCase()] ?? "en-US";
}
