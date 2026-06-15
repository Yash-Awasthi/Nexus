// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight Sentry error reporter — no SDK dependency.
 *
 * Posts error events to the Sentry HTTP Envelope API using native fetch.
 * Activated when SENTRY_DSN is set. No-ops silently when absent.
 *
 * Usage:
 *   import { sentryReporter } from "./sentry-reporter.js";
 *   sentryReporter.captureException(err, { request_id, url, method });
 *
 * Environment variables:
 *   SENTRY_DSN        — Sentry DSN  (https://<key>@<host>/api/<id>/envelope/)
 *   SENTRY_RELEASE    — release tag (default: process.env.npm_package_version)
 *   SENTRY_ENVIRONMENT — "production" | "staging" | "development" (default: NODE_ENV)
 *
 * Protocol reference:
 *   https://develop.sentry.dev/sdk/envelopes/
 */

interface SentryExtra {
  request_id?: string;
  url?: string;
  method?: string;
  userId?: string;
  [key: string]: unknown;
}

function _parseDsn(dsn: string): { url: string; publicKey: string } | null {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const host = u.host;
    const projectId = u.pathname.replace(/^\//, "");
    const url = `${u.protocol}//${host}/api/${projectId}/envelope/`;
    return { url, publicKey };
  } catch {
    return null;
  }
}

class SentryReporter {
  private readonly _dsn: ReturnType<typeof _parseDsn>;
  private readonly _release: string;
  private readonly _env: string;

  constructor() {
    const raw = process.env.SENTRY_DSN;
    this._dsn = raw ? _parseDsn(raw) : null;
    this._release = process.env.SENTRY_RELEASE ?? process.env.npm_package_version ?? "unknown";
    this._env = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development";
  }

  get enabled(): boolean {
    return !!this._dsn;
  }

  /**
   * Capture an exception and send it to Sentry.
   * Fire-and-forget — never throws; errors are written to stderr.
   */
  captureException(err: unknown, extra: SentryExtra = {}): void {
    if (!this._dsn) return;

    const error = err instanceof Error ? err : new Error(String(err));
    const eventId = _generateEventId();
    const now = Math.floor(Date.now() / 1_000);

    const event = {
      event_id: eventId,
      timestamp: now,
      platform: "node",
      level: "error",
      release: this._release,
      environment: this._env,
      exception: {
        values: [
          {
            type: error.name,
            value: error.message,
            stacktrace: {
              frames: _parseStack(error.stack ?? ""),
            },
          },
        ],
      },
      extra: {
        ...extra,
        node_version: process.version,
      },
      ...(extra.request_id
        ? {
            tags: { request_id: extra.request_id },
            request: {
              url: extra.url,
              method: extra.method,
            },
          }
        : {}),
    };

    // Sentry Envelope format: header\n item-header\n item\n
    const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
    const itemHeader = JSON.stringify({ type: "event", content_type: "application/json" });
    const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`;

    const { url, publicKey } = this._dsn;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${publicKey}`,
        "X-Sentry-Client": "nexus-api/1.0",
      },
      body,
    }).catch((fetchErr: unknown) => {
      process.stderr.write(`[Sentry] Failed to send event: ${fetchErr}\n`);
    });
  }
}

function _generateEventId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function _parseStack(
  stack: string,
): { filename: string; function: string; lineno?: number }[] {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = /at\s+(?:(.+?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/.exec(line.trim());
      if (!match) return null;
      return {
        function: match[1] ?? "<anonymous>",
        filename: match[2] ?? "<unknown>",
        lineno: match[3] ? parseInt(match[3], 10) : undefined,
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .reverse(); // Sentry expects innermost frame last
}

/** Singleton — lazily created so DSN is read at first use. */
export const sentryReporter = new SentryReporter();
