// SPDX-License-Identifier: Apache-2.0
/**
 * EasterEggToast — displays when an Easter egg is triggered.
 * Minimal, styled for the hacker aesthetic.
 */

import { useEffect, useState } from "react";
import type { EggEvent } from "~/lib/easterEggs";

interface Props {
  egg: EggEvent | null;
  dismiss: () => void;
}

export function EasterEggToast({ egg, dismiss }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (egg) {
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [egg]);

  if (!egg || !visible) return null;

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-5 py-3 rounded-lg text-sm font-mono cursor-pointer select-none"
      style={{
        background: "hsl(var(--primary)/0.15)",
        border: "1px solid hsl(var(--primary)/0.5)",
        color: "hsl(var(--primary))",
        backdropFilter: "blur(12px)",
        boxShadow: "0 0 20px hsl(var(--primary)/0.3)",
        animation: "egg-in 0.3s ease",
      }}
      onClick={dismiss}
    >
      <span className="mr-2 opacity-60">🥚</span>
      {egg.message}
      <span className="ml-3 text-xs opacity-50">[click to dismiss]</span>
    </div>
  );
}
