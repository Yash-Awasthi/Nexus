import { useEffect, useRef } from "react";

/**
 * GSAP stagger animation hook for card grids.
 * Animates children of the ref element with a staggered fade-in + slide-up.
 */
export function useGsapStagger<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;

    import("gsap").then(({ default: gsap }) => {
      if (cancelled || !ref.current) return;
      const children = ref.current.children;
      if (!children.length) return;

      gsap.fromTo(
        Array.from(children),
        { opacity: 0, y: 20 },
        {
          opacity: 1,
          y: 0,
          duration: 0.4,
          stagger: 0.06,
          ease: "power2.out",
        }
      );
    });

    return () => { cancelled = true; };
  }, deps);

  return ref;
}
