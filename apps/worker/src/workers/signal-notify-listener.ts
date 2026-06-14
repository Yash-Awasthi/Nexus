// SPDX-License-Identifier: Apache-2.0
/**
 * SignalNotifyListener — replaces 5-second polling for the hot path.
 *
 * Phase 2 — LISTEN/NOTIFY:
 *   Maintains a dedicated pg.Client connection that LISTENs on the
 *   "nexus_signals" Postgres channel.  The signals_after_insert trigger
 *   (migration 0001_signal_notify.sql) fires pg_notify on every INSERT,
 *   sending the new row as JSON.
 *
 *   On each notification:
 *     1. Parse the Signal JSON
 *     2. Apply passesGate() — filter by COUNCIL_MIN_PRIORITY (default: high)
 *     3. If it qualifies, enqueue a council.deliberate job on nexus-high
 *
 * Phase 4 — Governance gate:
 *   passesGate(priority) uses COUNCIL_MIN_PRIORITY to gate which signals
 *   get sent to the council.  Signals below the threshold are logged and
 *   dropped — they remain in the signals table and can be manually triggered
 *   via POST /council/trigger if needed.
 *
 * Fail-safe:
 *   On pg error the listener reconnects with exponential back-off (up to 30s).
 *   The SignalWorker (DB polling) continues running in parallel so no signal
 *   is permanently lost.
 */

import { Queue, type ConnectionOptions } from "bullmq";

// ── Config ────────────────────────────────────────────────────────────────────

const COUNCIL_MIN_PRIORITY = process.env.COUNCIL_MIN_PRIORITY ?? "high";
const QUEUE_HIGH           = "nexus-high";
const NOTIFY_CHANNEL       = "nexus_signals";

const PRIORITY_ORDER = ["low", "medium", "high", "critical"] as const;
type SignalPriority  = (typeof PRIORITY_ORDER)[number];

// ── Governance gate ───────────────────────────────────────────────────────────

function passesGate(priority: string): boolean {
  const minIdx = PRIORITY_ORDER.indexOf(COUNCIL_MIN_PRIORITY as SignalPriority);
  const sigIdx = PRIORITY_ORDER.indexOf(priority as SignalPriority);
  // Unknown priorities always fail the gate
  if (sigIdx === -1) return false;
  // If COUNCIL_MIN_PRIORITY is unrecognised, default to "high" gate
  return sigIdx >= (minIdx === -1 ? 2 : minIdx);
}

// ── Parsed signal shape from pg_notify payload ────────────────────────────────

interface NotifiedSignal {
  id:          string;
  signal_type: string;
  summary:     string;
  priority:    string;
  created_at:  string;
}

// ── Listener class ────────────────────────────────────────────────────────────

export class SignalNotifyListener {
  private client:      unknown  = null;  // pg.Client — dynamically imported
  private queue:       Queue;
  private running      = false;
  private reconnectMs  = 1_000;

  constructor(private readonly connection: ConnectionOptions) {
    this.queue = new Queue(QUEUE_HIGH, { connection });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(
      JSON.stringify({
        level:        "info",
        event:        "signal-notify-listener.starting",
        channel:      NOTIFY_CHANNEL,
        minPriority:  COUNCIL_MIN_PRIORITY,
      }),
    );
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.queue.close();
    if (this.client) {
      try {
        const pg = this.client as { end(): Promise<void> };
        await pg.end();
      } catch {
        // best-effort
      }
      this.client = null;
    }
    console.log(JSON.stringify({ level: "info", event: "signal-notify-listener.stopped" }));
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.running) return;

    try {
      const pg = await import("pg");
      const Client = (pg.default?.Client ?? pg.Client) as new (
        opts: Record<string, unknown>,
      ) => {
        connect(): Promise<void>;
        end():     Promise<void>;
        query(sql: string): Promise<unknown>;
        on(event: "notification", handler: (msg: { channel: string; payload?: string }) => void): void;
        on(event: "error",        handler: (err: Error) => void): void;
        on(event: "end",          handler: () => void): void;
      };

      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        // Keep connection alive — not suitable for a pool
        keepAlive: true,
      });

      client.on("error", (err: Error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "signal-notify-listener.pg-error",
            error: err.message,
          }),
        );
        this.client = null;
        this.scheduleReconnect();
      });

      client.on("end", () => {
        if (!this.running) return;
        console.warn(
          JSON.stringify({ level: "warn", event: "signal-notify-listener.pg-disconnected" }),
        );
        this.client = null;
        this.scheduleReconnect();
      });

      client.on("notification", (msg) => {
        if (msg.channel === NOTIFY_CHANNEL && msg.payload) {
          this.handleNotification(msg.payload).catch((err: Error) =>
            console.error(
              JSON.stringify({
                level: "error",
                event: "signal-notify-listener.handle-error",
                error: err.message,
              }),
            ),
          );
        }
      });

      await client.connect();
      await client.query(`LISTEN "${NOTIFY_CHANNEL}"`);

      this.client      = client;
      this.reconnectMs = 1_000; // reset back-off on success

      console.log(
        JSON.stringify({ level: "info", event: "signal-notify-listener.connected", channel: NOTIFY_CHANNEL }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "signal-notify-listener.connect-failed",
          error: (err as Error).message,
        }),
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000); // cap at 30s
    console.log(
      JSON.stringify({ level: "info", event: "signal-notify-listener.reconnecting", delayMs: delay }),
    );
    setTimeout(() => this.connect().catch(console.error), delay);
  }

  // ── Notification handler ───────────────────────────────────────────────────

  private async handleNotification(payload: string): Promise<void> {
    let signal: NotifiedSignal;
    try {
      signal = JSON.parse(payload) as NotifiedSignal;
    } catch {
      console.warn(
        JSON.stringify({
          level:   "warn",
          event:   "signal-notify-listener.invalid-payload",
          payload: payload.slice(0, 200),
        }),
      );
      return;
    }

    if (!passesGate(signal.priority)) {
      console.log(
        JSON.stringify({
          level:      "info",
          event:      "council.gate.skipped",
          signalId:   signal.id,
          priority:   signal.priority,
          minPriority: COUNCIL_MIN_PRIORITY,
        }),
      );
      return;
    }

    await this.queue.add(
      "council.deliberate",
      {
        proposal: {
          title:       `[${signal.signal_type}] ${signal.summary.slice(0, 80)}`,
          description: signal.summary,
        },
        signalId: signal.id,
      },
      {
        attempts:    2,
        backoff:     { type: "fixed", delay: 5_000 },
        removeOnComplete: { count: 100 },
        removeOnFail:     { count: 50  },
      },
    );

    console.log(
      JSON.stringify({
        level:      "info",
        event:      "council.job.enqueued",
        signalId:   signal.id,
        signalType: signal.signal_type,
        priority:   signal.priority,
      }),
    );
  }
}
