// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

export interface LspLanguage {
  language: string;
  available: boolean;
  reason?: string;
}

export interface LspStatus {
  enabled: boolean;
  root?: string;
  servers: {
    language: string;
    state: string;
    pid?: number;
    rssMb?: number;
    requests?: number;
  }[];
  languages: LspLanguage[];
}

/**
 * LSP availability for the symbol picker. Undefined while loading (assume usable),
 * null when the probe failed (treated as unavailable). Never blocks typing.
 */
export function useLspStatus(enabled = true): LspStatus | null | undefined {
  const [status, setStatus] = useState<LspStatus | null | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/lsp/status");
        const data = res.ok ? ((await res.json()) as LspStatus) : null;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return status;
}

/** True until a probe says otherwise, so the menu never waits on the network. */
export function lspSymbolsAvailable(status: LspStatus | null | undefined): boolean {
  if (status === undefined) return true;
  if (status === null) return false;
  return status.enabled && status.languages.some((l) => l.available);
}

/** The server variable the status payload says is missing. */
export function lspUnavailableReason(status: LspStatus | null | undefined): string {
  if (status === undefined) return "";
  if (status === null) return "Symbol search needs a language server.";
  const missing = status.languages.find((l) => !l.available);
  return (
    missing?.reason ??
    (status.enabled ? "Symbol search needs a language server." : "Symbol search is disabled.")
  );
}
