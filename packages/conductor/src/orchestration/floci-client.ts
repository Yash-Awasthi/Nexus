// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP client for the Floci AWS emulator (default :4566).
 * Tries Quarkus health paths documented in runtime/healthchecks.yaml.
 */

export type FlociHealthStatus = {
  reachable: boolean;
  endpoint: string;
  healthPath?: string;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
  checkedAt: string;
};

export type FlociRequestResult<T = unknown> = {
  ok: boolean;
  status: number;
  bodyText: string;
  latencyMs: number;
  data?: T;
};

export class FlociClientError extends Error {
  constructor(
    message: string,
    public readonly code: "UNREACHABLE" | "HTTP_ERROR" | "TIMEOUT" | "UNKNOWN_ACTION",
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "FlociClientError";
  }
}

const HEALTH_PATHS = ["/health", "/_floci/health", "/q/health"];

export function normalizeFlociEndpoint(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveFlociEndpoint(): string {
  return normalizeFlociEndpoint(process.env.GHOSTSTACK_FLOCI_URL ?? "http://localhost:4566");
}

export async function probeFlociHealth(
  endpoint: string,
  timeoutMs = 4000,
): Promise<FlociHealthStatus> {
  const base = normalizeFlociEndpoint(endpoint);
  const started = Date.now();

  // In offline mode, skip HTTP entirely — AbortSignal.timeout() can fail to
  // abort socket-level connects on some platforms (Windows), causing the probe
  // to block for the OS TCP timeout (~120s) instead of the intended timeoutMs.
  const offline =
    process.env.GHOSTSTACK_OFFLINE_MODE === "1" ||
    (process.env.GHOSTSTACK_OFFLINE_MODE ?? "").toLowerCase() === "true";
  if (offline) {
    return {
      reachable: false,
      endpoint: base,
      latencyMs: Date.now() - started,
      error: "offline mode — probe skipped",
      checkedAt: new Date().toISOString(),
    };
  }

  let lastError: string | undefined;

  for (const healthPath of HEALTH_PATHS) {
    try {
      const res = await fetch(`${base}${healthPath}`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - started;
      if (res.ok) {
        return {
          reachable: true,
          endpoint: base,
          healthPath,
          latencyMs,
          httpStatus: res.status,
          checkedAt: new Date().toISOString(),
        };
      }
      lastError = `HTTP ${res.status} at ${healthPath}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  return {
    reachable: false,
    endpoint: base,
    latencyMs: Date.now() - started,
    error: lastError ?? "unknown",
    checkedAt: new Date().toISOString(),
  };
}

export type FlociFetchOptions = Omit<RequestInit, "signal"> & {
  requestUrl?: string;
  timeoutMs?: number;
};

export async function flociFetch(
  endpoint: string,
  init: FlociFetchOptions,
): Promise<FlociRequestResult> {
  const base = normalizeFlociEndpoint(endpoint);
  const requestUrl = init.requestUrl ?? base;
  const timeoutMs = init.timeoutMs ?? 15000;
  const started = Date.now();

  try {
    const { timeoutMs: _t, requestUrl: _u, ...rest } = init;
    const res = await fetch(requestUrl.startsWith("http") ? requestUrl : `${base}${requestUrl}`, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      bodyText,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    throw new FlociClientError(
      `Floci request failed: ${(err as Error).message}`,
      "UNREACHABLE",
      undefined,
      undefined,
    );
  }
}
