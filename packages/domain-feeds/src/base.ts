// SPDX-License-Identifier: Apache-2.0
/**
 * Infrastructure layer of @nexus/domain-feeds — everything the per-domain
 * adapters build on. Extracted from the former 3,600-line monolith (§16.6);
 * `./index.js` remains the public barrel so consumers are unaffected.
 *
 * Contents:
 *   shared fetch/XML helpers, FeedEvent/FeedPage, FeedAdapter base,
 *   FeedCache, FeedRegistry, SweepOrchestrator, DeltaEngine, TelegramAlerter.
 */

// ── Shared fetch utility ───────────────────────────────────────────────────────

import type { MarketEvent } from "./index.js";

export type HttpGetFn = (url: string, headers?: Record<string, string>) => Promise<unknown>;

export async function safeFetch(
  url: string,
  opts: { timeout?: number; headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 20_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json")) return res.json();
    return res.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export function buildMockResponse<T>(domain: string, count = 3): T[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${domain}-mock-${i + 1}`,
    timestamp: new Date().toISOString(),
    severity: "medium",
    source: `mock-${domain}`,
    summary: `Mock ${domain} event ${i + 1}`,
  })) as T[];
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().split("T")[0]!;
}

// ── Minimal Atom/XML extraction (dependency-free) ──────────────────────────────
// arXiv (and later EDGAR / legislative) serve well-formed Atom/XML. Rather than
// pull an XML-parser dep for a handful of regular feeds, extract the few fields we
// need. Tags may carry a namespace prefix (e.g. `arxiv:doi`) — the (?:\w+:)? makes
// it optional. Only for trusted, well-formed provider XML — not a general parser.

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // decode &amp; last so it can't double-decode
}

/** Inner text of every `<tag>…</tag>` (namespace prefix optional), trimmed + decoded. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    out.push(decodeXmlEntities(m[1]!.replace(/\s+/g, " ").trim()));
  }
  return out;
}

/** Value of `attr` on the first `<tag … attr="…">` (namespace prefix optional). */
export function xmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*\\b${attr}="([^"]*)"`);
  return re.exec(xml)?.[1];
}

// ── Base types ─────────────────────────────────────────────────────────────────

export interface FeedEvent {
  id: string;
  timestamp: string;
  severity?: "low" | "medium" | "high" | "critical";
  source: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface FeedPage<T> {
  domain: string;
  events: T[];
  fetchedAt: string;
  totalCount: number;
  cached: boolean;
}

// ── FeedAdapter base ───────────────────────────────────────────────────────────

export interface FeedAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  rateLimitRpm?: number;
  corsOrigin?: string;
  http?: HttpGetFn;
}

export abstract class FeedAdapter<T extends FeedEvent> {
  abstract readonly domain: string;
  protected baseUrl: string;
  protected apiKey?: string;
  protected corsOrigin?: string;
  private rateLimitRpm: number;
  private requestTimestamps: number[] = [];
  protected http: HttpGetFn;

  constructor(opts: FeedAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.corsOrigin = opts.corsOrigin;
    this.rateLimitRpm = opts.rateLimitRpm ?? 60;
    this.http = opts.http ?? ((url, headers) => safeFetch(url, { headers }));
  }

  checkRateLimit(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60_000);
    if (this.requestTimestamps.length >= this.rateLimitRpm) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  protected buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.corsOrigin) h["Origin"] = this.corsOrigin;
    return h;
  }

  abstract fetch(opts?: Record<string, unknown>): Promise<T[]>;
}

// ── FeedCache ──────────────────────────────────────────────────────────────────

export class FeedCache {
  private store = new Map<string, { events: FeedEvent[]; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs;
  }

  set(domain: string, events: FeedEvent[]): void {
    this.store.set(domain, { events: [...events], expiresAt: Date.now() + this.ttlMs });
  }

  get(domain: string): FeedEvent[] | null {
    const entry = this.store.get(domain);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(domain);
      return null;
    }
    return [...entry.events];
  }

  invalidate(domain: string): void {
    this.store.delete(domain);
  }
  clear(): void {
    this.store.clear();
  }
  size(): number {
    return this.store.size;
  }
  domains(): string[] {
    return [...this.store.keys()];
  }
}

// ── DomainName union ───────────────────────────────────────────────────────────

export type DomainName =
  | "aviation"
  | "climate"
  | "conflict"
  | "economic"
  | "displacement"
  | "cyber"
  | "health"
  | "imagery"
  | "seismology"
  | "wildfire"
  | "maritime"
  | "market"
  | "sanctions"
  | "radiation";

// ── FeedRegistry ───────────────────────────────────────────────────────────────

export class FeedRegistry {
  private adapters = new Map<string, FeedAdapter<FeedEvent>>();
  private cache: FeedCache;

  constructor(cache?: FeedCache) {
    this.cache = cache ?? new FeedCache();
  }

  register(adapter: FeedAdapter<FeedEvent>): this {
    this.adapters.set(adapter.domain, adapter);
    return this;
  }

  get(domain: string): FeedAdapter<FeedEvent> | undefined {
    return this.adapters.get(domain);
  }
  domains(): string[] {
    return [...this.adapters.keys()];
  }

  async fetch(domain: string, opts?: Record<string, unknown>): Promise<FeedPage<FeedEvent>> {
    const adapter = this.adapters.get(domain);
    if (!adapter) throw new Error(`No feed adapter registered for domain: ${domain}`);

    const cached = this.cache.get(domain);
    if (cached)
      return {
        domain,
        events: cached,
        fetchedAt: new Date().toISOString(),
        totalCount: cached.length,
        cached: true,
      };

    const events = await adapter.fetch(opts);
    this.cache.set(domain, events);
    return {
      domain,
      events,
      fetchedAt: new Date().toISOString(),
      totalCount: events.length,
      cached: false,
    };
  }

  async fetchAll(opts?: Record<string, unknown>): Promise<FeedPage<FeedEvent>[]> {
    return Promise.allSettled([...this.adapters.keys()].map((d) => this.fetch(d, opts))).then(
      (results) =>
        results
          .filter((r): r is PromiseFulfilledResult<FeedPage<FeedEvent>> => r.status === "fulfilled")
          .map((r) => r.value),
    );
  }

  getCache(): FeedCache {
    return this.cache;
  }
}

// ── SweepResult ────────────────────────────────────────────────────────────────

export interface SweepSourceStatus {
  domain: string;
  ok: boolean;
  count: number;
  latencyMs: number;
  error?: string;
}

export interface SweepResult {
  timestamp: string;
  domains: FeedPage<FeedEvent>[];
  health: SweepSourceStatus[];
  meta: { sourcesOk: number; sourcesDown: number; totalEvents: number; sweepMs: number };
}

// ── SweepOrchestrator ──────────────────────────────────────────────────────────

export class SweepOrchestrator {
  private registry: FeedRegistry;
  private history: SweepResult[] = [];
  private maxHistory: number;

  constructor(registry: FeedRegistry, maxHistory = 10) {
    this.registry = registry;
    this.maxHistory = maxHistory;
  }

  async sweep(): Promise<SweepResult> {
    const start = Date.now();
    const domains = this.registry.domains();

    const settled = await Promise.allSettled(
      domains.map(async (domain) => {
        const t0 = Date.now();
        try {
          const page = await this.registry.fetch(domain, {});
          return { domain, page, latencyMs: Date.now() - t0, error: null };
        } catch (e) {
          return { domain, page: null, latencyMs: Date.now() - t0, error: String(e) };
        }
      }),
    );

    const pages: FeedPage<FeedEvent>[] = [];
    const health: SweepSourceStatus[] = [];

    for (const r of settled) {
      if (r.status === "fulfilled") {
        const { domain, page, latencyMs, error } = r.value;
        health.push({
          domain,
          ok: !error,
          count: page?.events.length ?? 0,
          latencyMs,
          error: error ?? undefined,
        });
        if (page) pages.push(page);
      }
    }

    const ok = health.filter((h) => h.ok).length;
    const result: SweepResult = {
      timestamp: new Date().toISOString(),
      domains: pages,
      health,
      meta: {
        sourcesOk: ok,
        sourcesDown: health.length - ok,
        totalEvents: pages.reduce((s, p) => s + p.totalCount, 0),
        sweepMs: Date.now() - start,
      },
    };

    this.history.unshift(result);
    if (this.history.length > this.maxHistory) this.history.pop();
    return result;
  }

  lastSweep(): SweepResult | null {
    return this.history[0] ?? null;
  }
  sweepHistory(): SweepResult[] {
    return [...this.history];
  }
}

// ── DeltaEngine ────────────────────────────────────────────────────────────────

export interface DeltaSignal {
  key: string;
  label?: string;
  from?: number;
  to?: number;
  change?: number;
  pctChange?: number;
  direction: "up" | "down" | "resolved";
  severity: "critical" | "high" | "moderate";
  reason?: string;
  text?: string;
}

export interface DeltaResult {
  timestamp: string;
  previous: string | null;
  signals: { new: DeltaSignal[]; escalated: DeltaSignal[]; deescalated: DeltaSignal[] };
  summary: {
    totalChanges: number;
    criticalChanges: number;
    direction: "risk-off" | "risk-on" | "mixed";
    signalBreakdown: { new: number; escalated: number; deescalated: number };
  };
}

const DELTA_NUMERIC_THRESHOLDS: Record<string, number> = {
  vix: 5,
  hy_spread: 5,
  yield_10y2y: 10,
  wti: 3,
  brent: 3,
  natgas: 5,
  gold: 2,
  silver: 3,
  unemployment: 2,
  fed_funds: 1,
  "10y_yield": 3,
};

const DELTA_COUNT_THRESHOLDS: Record<string, number> = {
  conflict_events: 5,
  conflict_fatalities: 10,
  cyber_critical: 3,
  seismic_events: 10,
  wildfire_detections: 500,
  displacement_events: 2,
};

export class DeltaEngine {
  compute(current: SweepResult, previous: SweepResult): DeltaResult {
    const signals: DeltaResult["signals"] = { new: [], escalated: [], deescalated: [] };
    let criticalChanges = 0;

    // Extract per-domain event counts
    const currCounts = this._domainCounts(current);
    const prevCounts = this._domainCounts(previous);

    for (const [key, threshold] of Object.entries(DELTA_COUNT_THRESHOLDS)) {
      const domain = key.split("_")[0] ?? key;
      const curr = currCounts[domain] ?? 0;
      const prev = prevCounts[domain] ?? 0;
      const diff = curr - prev;
      if (Math.abs(diff) >= threshold) {
        const pct = prev > 0 ? (diff / prev) * 100 : diff > 0 ? 100 : 0;
        const entry: DeltaSignal = {
          key,
          label: domain,
          from: prev,
          to: curr,
          change: diff,
          pctChange: parseFloat(pct.toFixed(1)),
          direction: diff > 0 ? "up" : "down",
          severity:
            Math.abs(diff) >= threshold * 5
              ? "critical"
              : Math.abs(diff) >= threshold * 2
                ? "high"
                : "moderate",
        };
        if (diff > 0) {
          signals.escalated.push(entry);
          if (entry.severity === "critical") criticalChanges++;
        } else signals.deescalated.push(entry);
      }
    }

    // Market signals from MarketFeed
    const currMarket = this._marketMap(current);
    const prevMarket = this._marketMap(previous);
    for (const sym of Object.keys(currMarket)) {
      const curr = currMarket[sym] ?? 0;
      const prev = prevMarket[sym];
      if (prev === undefined) continue;
      const pct = prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : 0;
      const threshold = DELTA_NUMERIC_THRESHOLDS[sym.toLowerCase()] ?? 5;
      if (Math.abs(pct) >= threshold) {
        const entry: DeltaSignal = {
          key: sym,
          label: sym,
          from: prev,
          to: curr,
          pctChange: parseFloat(pct.toFixed(2)),
          direction: pct > 0 ? "up" : "down",
          severity:
            Math.abs(pct) > threshold * 3
              ? "critical"
              : Math.abs(pct) > threshold * 2
                ? "high"
                : "moderate",
        };
        if (pct > 0) {
          signals.escalated.push(entry);
          if (entry.severity === "critical") criticalChanges++;
        } else signals.deescalated.push(entry);
      }
    }

    // Source degradation
    const currDown = current.meta.sourcesDown;
    const prevDown = previous.meta.sourcesDown;
    if (currDown > prevDown + 2) {
      signals.new.push({
        key: "source_degradation",
        reason: `${currDown - prevDown} additional sources failing (${currDown} total down)`,
        direction: "up",
        severity: currDown > 5 ? "critical" : "moderate",
      });
    }

    const riskUp = signals.escalated.filter((s) =>
      ["^VIX", "hy_spread", "conflict_events"].includes(s.key),
    ).length;
    const riskDown = signals.deescalated.filter((s) =>
      ["^VIX", "hy_spread", "conflict_events"].includes(s.key),
    ).length;

    return {
      timestamp: current.timestamp,
      previous: previous.timestamp,
      signals,
      summary: {
        totalChanges: signals.new.length + signals.escalated.length + signals.deescalated.length,
        criticalChanges,
        direction: riskUp > riskDown + 1 ? "risk-off" : riskDown > riskUp + 1 ? "risk-on" : "mixed",
        signalBreakdown: {
          new: signals.new.length,
          escalated: signals.escalated.length,
          deescalated: signals.deescalated.length,
        },
      },
    };
  }

  private _domainCounts(sweep: SweepResult): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of sweep.domains) out[p.domain] = p.totalCount;
    return out;
  }

  private _marketMap(sweep: SweepResult): Record<string, number> {
    const market = sweep.domains.find((d) => d.domain === "market");
    if (!market) return {};
    const out: Record<string, number> = {};
    for (const e of market.events) {
      const m = e as MarketEvent;
      out[m.symbol] = m.price;
    }
    return out;
  }
}

// ── TelegramAlerter ────────────────────────────────────────────────────────────

export type AlertTier = "FLASH" | "PRIORITY" | "ROUTINE";

interface TierConfig {
  emoji: string;
  cooldownMs: number;
  maxPerHour: number;
}

const TIER_CONFIGS: Record<AlertTier, TierConfig> = {
  FLASH: { emoji: "🔴", cooldownMs: 5 * 60_000, maxPerHour: 6 },
  PRIORITY: { emoji: "🟡", cooldownMs: 30 * 60_000, maxPerHour: 4 },
  ROUTINE: { emoji: "🔵", cooldownMs: 60 * 60_000, maxPerHour: 2 },
};

export interface TelegramAlert {
  tier: AlertTier;
  text: string;
  timestamp: string;
}
export type TelegramCommandHandler = (command: string, chatId: string) => Promise<string | null>;

export class TelegramAlerter {
  private botToken: string;
  private chatId: string;
  private alertHistory: TelegramAlert[] = [];
  private muteUntil: number | null = null;
  private lastUpdateId = 0;
  private commandHandler?: TelegramCommandHandler;

  constructor(opts: { botToken: string; chatId: string; commandHandler?: TelegramCommandHandler }) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.commandHandler = opts.commandHandler;
  }

  /** Send a structured alert. Returns true if sent, false if rate-limited/muted. */
  async send(tier: AlertTier, message: string): Promise<boolean> {
    if (this.muteUntil && Date.now() < this.muteUntil) return false;
    if (!this._checkRateLimit(tier)) return false;

    const cfg = TIER_CONFIGS[tier];
    const ts = new Date().toISOString();
    const text = `${cfg.emoji} *[${tier}]* — ${ts.replace("T", " ").slice(0, 19)} UTC\n\n${message}`;

    this.alertHistory.unshift({ tier, text: message, timestamp: ts });
    if (this.alertHistory.length > 200) this.alertHistory.pop();

    await this._apiCall("sendMessage", {
      chat_id: this.chatId,
      text: text.slice(0, 4096),
      parse_mode: "Markdown",
    });
    return true;
  }

  /** Push alerts derived from a DeltaResult. */
  async sendDelta(delta: DeltaResult): Promise<void> {
    if (delta.summary.criticalChanges > 0 || delta.signals.new.length > 0) {
      const lines = [
        ...delta.signals.new.map((s) => `• NEW: ${s.reason ?? s.key}`),
        ...delta.signals.escalated
          .filter((s) => s.severity === "critical")
          .map(
            (s) =>
              `• ${s.label ?? s.key}: ${s.from} → ${s.to} (${s.pctChange !== undefined ? `${s.pctChange >= 0 ? "+" : ""}${s.pctChange}%` : `Δ${s.change}`})`,
          ),
      ];
      if (lines.length) await this.send("FLASH", lines.join("\n"));
    } else if (delta.signals.escalated.length > 0) {
      const lines = delta.signals.escalated
        .slice(0, 5)
        .map(
          (s) =>
            `• ${s.label ?? s.key}: ${s.direction === "up" ? "▲" : "▼"} ${s.pctChange !== undefined ? `${s.pctChange}%` : `Δ${s.change}`}`,
        );
      await this.send("PRIORITY", `${delta.summary.direction.toUpperCase()}\n${lines.join("\n")}`);
    }
  }

  /** Poll for bot commands and dispatch to handler. */
  async pollCommands(): Promise<void> {
    if (!this.commandHandler) return;
    try {
      const raw = (await safeFetch(
        `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=0`,
      )) as { result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };

      for (const update of raw?.result ?? []) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
        const msg = update.message;
        if (!msg?.text?.startsWith("/")) continue;
        const chatId = String(msg.chat.id);
        const reply = await this.commandHandler(msg.text, chatId);
        if (reply) {
          await this._apiCall("sendMessage", { chat_id: chatId, text: reply.slice(0, 4096) });
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  mute(ms = 3600_000): void {
    this.muteUntil = Date.now() + ms;
  }
  unmute(): void {
    this.muteUntil = null;
  }
  recentAlerts(n = 20): TelegramAlert[] {
    return this.alertHistory.slice(0, n);
  }

  private _checkRateLimit(tier: AlertTier): boolean {
    const cfg = TIER_CONFIGS[tier];
    const window = 3600_000;
    const now = Date.now();
    const recent = this.alertHistory.filter(
      (a) => a.tier === tier && now - new Date(a.timestamp).getTime() < window,
    );
    if (recent.length >= cfg.maxPerHour) return false;
    const last = recent[0];
    if (last && now - new Date(last.timestamp).getTime() < cfg.cooldownMs) return false;
    return true;
  }

  private async _apiCall(method: string, body: Record<string, unknown>): Promise<void> {
    await safeFetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeout: 10_000,
    }).catch(() => {
      /* non-fatal */
    });
  }
}
