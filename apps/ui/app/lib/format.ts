// SPDX-License-Identifier: Apache-2.0
/** Compact value formatting shared by dashboard/admin stat displays. */

export const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

export const fmtCost = (usd: number) =>
  usd <= 0 ? "$0.00" : usd < 0.01 ? `$${(usd * 100).toFixed(2)}¢` : `$${usd.toFixed(2)}`;

export const fmtLatency = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
