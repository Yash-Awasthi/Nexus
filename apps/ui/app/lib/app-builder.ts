// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { apiFetch } from "~/lib/api";

let known: Promise<boolean> | null = null;

/** Whether this server can run App builder (it installs and builds); null until it answers. */
export function useAppBuilderAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    known ??= apiFetch<{ available: boolean }>("/api/v1/apps/status")
      .then((r) => r.available)
      .catch(() => {
        known = null;
        return false;
      });
    let live = true;
    void known.then((a) => live && setAvailable(a));
    return () => {
      live = false;
    };
  }, []);
  return available;
}
