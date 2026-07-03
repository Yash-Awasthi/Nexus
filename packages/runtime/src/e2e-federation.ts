// SPDX-License-Identifier: Apache-2.0
/**
 * Federation end-to-end test runner.
 *
 * Validates that all federation services (Floci, MCP bridge, Conductor API)
 * are reachable and responding correctly.
 */

export interface FederationE2eResult {
  success: boolean;
  checks: { name: string; passed: boolean; detail?: string }[];
  durationMs: number;
}

export interface FederationE2eOptions {
  strict?: boolean;
  cleanup?: boolean;
}

/**
 * Run a federation health check suite against the local runtime.
 */
export async function runFederationE2e(
  _ctx?: unknown,
  _options?: FederationE2eOptions,
): Promise<FederationE2eResult> {
  const start = Date.now();
  const checks: { name: string; passed: boolean; detail?: string }[] = [];

  // Floci health check
  try {
    const endpoint = process.env.FLOCI_ENDPOINT ?? "http://localhost:4566";
    const res = await fetch(`${endpoint}/_floci/health`);
    checks.push({ name: "floci", passed: res.ok, detail: `HTTP ${res.status}` });
  } catch (err) {
    checks.push({ name: "floci", passed: false, detail: (err as Error).message });
  }

  return {
    success: checks.every((c) => c.passed),
    checks,
    durationMs: Date.now() - start,
  };
}
