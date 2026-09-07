// SPDX-License-Identifier: Apache-2.0
/**
 * Connection-level message rate limiter for WebSocket / SSE clients.
 *
 * The existing `rate-limiter.ts` throttles by IP or user identity across all
 * HTTP requests. But a single authenticated WebSocket client can still flood
 * the in-process SSE bus with hundreds of subscribe/unsubscribe/ping frames
 * per second — each triggering Map lookups, listener churn, and ping timers.
 *
 * This limiter caps messages per *connection* (not per identity), so a client
 * that spams frames gets throttled independently of who they are. It uses a
 * fixed-window counter that resets every `windowMs`, with no shared state
 * between connections.
 *
 * Usage:
 *   const throttle = new ConnectionMessageThrottle({ maxMessages: 60, windowMs: 1000 });
 *   // In the message handler:
 *   if (!throttle.allow(ws)) {
 *     ws.close(1008, "message flood");
 *     return;
 *   }
 */

export interface ThrottleConfig {
  /** Max messages per window per connection. */
  maxMessages: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

interface ConnState {
  count: number;
  windowStart: number;
}

/**
 * Per-connection message throttle. Keys by the WebSocket object identity.
 *
 * - `allow(ws)` returns `true` if the message is permitted, `false` if the
 *   client has exceeded its per-window budget (and should be throttled).
 * - `release(ws)` removes state when a connection closes (prevents leaks).
 * - `getStats()` returns a snapshot for diagnostics.
 */
export class ConnectionMessageThrottle {
  private readonly config: ThrottleConfig;
  private readonly states = new Map<object, ConnState>();

  constructor(config: ThrottleConfig) {
    this.config = config;
  }

  /**
   * Check if a message from `ws` is allowed. Consumes one token.
   * Returns `true` if allowed, `false` if the budget is exhausted.
   */
  allow(ws: object): boolean {
    const now = Date.now();
    let st = this.states.get(ws);
    if (!st) {
      st = { count: 0, windowStart: now };
      this.states.set(ws, st);
    }

    // Reset the window if it has elapsed.
    if (now - st.windowStart >= this.config.windowMs) {
      st.count = 0;
      st.windowStart = now;
    }

    st.count++;
    return st.count <= this.config.maxMessages;
  }

  /**
   * Remove all state for a connection. Call on `ws.on("close")`.
   */
  release(ws: object): void {
    this.states.delete(ws);
  }

  /**
   * Get the current count for a connection without consuming a token.
   */
  getCount(ws: object): number {
    return this.states.get(ws)?.count ?? 0;
  }

  /**
   * Total connections currently tracked.
   */
  getStats(): { trackedConnections: number; config: ThrottleConfig } {
    return {
      trackedConnections: this.states.size,
      config: this.config,
    };
  }

  /**
   * Drop all state (for tests / shutdown).
   */
  reset(): void {
    this.states.clear();
  }
}
