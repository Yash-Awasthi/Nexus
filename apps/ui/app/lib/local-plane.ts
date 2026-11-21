// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { apiFetch } from "~/lib/api";

let known: Promise<boolean> | null = null;

/**
 * Whether this deployment runs on the user's own machine (desktop app or a local
 * install). The API answers /api/local/status only for loopback callers and 403s
 * on a hosted site, so a failed request means "not local".
 *
 * Returns null until the server answers; callers should treat null as not local,
 * so a local-only surface is never shown before the check settles.
 */
export function useLocalPlane(): boolean | null {
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => {
    known ??= apiFetch<{ deployment?: string }>("/api/local/status")
      .then((s) => s.deployment === "local" || s.deployment === "local_forced")
      .catch(() => {
        known = null;
        return false;
      });
    let live = true;
    void known.then((v) => live && setLocal(v));
    return () => {
      live = false;
    };
  }, []);
  return local;
}
