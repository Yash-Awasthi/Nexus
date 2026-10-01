// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "./motion";

/**
 * The fixed 3D backdrop. three.js loads only here, after first paint; without WebGL the page keeps
 * its CSS backdrop and nothing else changes.
 */
export function SceneCanvas({ onSection }: { onSection?: (key: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onSection);
  report.current = onSection;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let stopped = false;
    let dispose: (() => void) | null = null;
    void (async () => {
      try {
        const m = await import("./council-scene");
        if (stopped) return;
        dispose = m.mountCouncilScene(el, {
          reducedMotion: prefersReducedMotion(),
          onSection: (key) => report.current?.(key),
        });
      } catch {
        // The chunk failed to load; the CSS backdrop stays.
      }
    })();
    return () => {
      stopped = true;
      dispose?.();
    };
  }, []);

  return (
    <div
      ref={host}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 transition-opacity duration-700"
    />
  );
}
