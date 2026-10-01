// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

interface GatewayModels {
  models?: { id: string; available: boolean }[];
}

/** Models the caller can reach through the gateway: their saved ones first, then live aliases. */
export function useModelIds(): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/gateway/models");
        const data = res.ok ? ((await res.json()) as GatewayModels) : null;
        if (!cancelled && data?.models)
          setIds(data.models.filter((m) => m.available).map((m) => m.id));
      } catch {
        // No list: pickers keep the model already chosen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return ids;
}
