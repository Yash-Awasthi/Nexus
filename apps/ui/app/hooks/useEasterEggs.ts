// SPDX-License-Identifier: Apache-2.0
/**
 * useEasterEggs — registers all Easter egg listeners and returns triggered eggs.
 */

import { useState, useEffect, useCallback } from "react";
import { initEasterEggs, type EggEvent } from "~/lib/easterEggs";

export function useEasterEggs() {
  const [egg, setEgg] = useState<EggEvent | null>(null);

  const onEgg = useCallback((e: EggEvent) => {
    e.action?.();
    setEgg(e);
    // Auto-dismiss after 4 seconds
    setTimeout(() => setEgg(null), 4_000);
  }, []);

  useEffect(() => {
    const cleanup = initEasterEggs(onEgg);
    return cleanup;
  }, [onEgg]);

  return { egg, dismiss: () => setEgg(null) };
}
