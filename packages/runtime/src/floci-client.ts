// SPDX-License-Identifier: Apache-2.0
/**
 * Floci client — resolves and probes the Floci local AWS emulator endpoint.
 *
 * Floci is a lightweight LocalStack-compatible emulator that runs alongside
 * the Conductor runtime. This module provides endpoint resolution and health
 * probing as pure functions with no side effects.
 */

export interface FlociHealth {
  reachable: boolean;
  latencyMs: number;
  endpoint: string;
  healthPath: string;
  /** Error message when the probe fails. */
  error?: string;
}

/** Resolve the Floci endpoint from environment or fall back to default. */
export function resolveFlociEndpoint(): string {
  return process.env.FLOCI_ENDPOINT ?? "http://localhost:4566";
}

/** Probe Floci health via HTTP GET — returns reachability and latency. */
export async function probeFlociHealth(
  endpoint?: string,
  _timeoutMs?: number,
): Promise<FlociHealth> {
  const resolvedEndpoint = endpoint ?? resolveFlociEndpoint();
  // Floci serves /_localstack/health for LocalStack backward compatibility.
  // It does NOT have a /_floci/health endpoint — that was a Conductor invention.
  const healthPath = "/_localstack/health";
  const start = Date.now();
  try {
    const res = await fetch(`${resolvedEndpoint}${healthPath}`);
    return {
      reachable: res.ok,
      latencyMs: Date.now() - start,
      endpoint: resolvedEndpoint,
      healthPath,
    };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      endpoint: resolvedEndpoint,
      healthPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
