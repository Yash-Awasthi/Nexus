// SPDX-License-Identifier: Apache-2.0
import { animate, createSpring, utils, type JSAnimation } from "animejs";
import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Lifts every [data-reveal] child of `root` into view as it scrolls in. `data-reveal="left"` and
 * `"scale"` pick another entrance; `data-delay` staggers siblings, in milliseconds.
 */
export function useReveal(root: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = root.current;
    if (!el || !enabled) return;
    const running: JSAnimation[] = [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          const t = entry.target as HTMLElement;
          const kind = t.dataset.reveal;
          const from: Record<string, number[]> =
            kind === "left"
              ? { translateX: [-36, 0] }
              : kind === "scale"
                ? { scale: [0.93, 1] }
                : { translateY: [30, 0] };
          running.push(
            animate(t, {
              opacity: [0, 1],
              ...from,
              duration: 1000,
              delay: Number(t.dataset.delay ?? 0),
              ease: "outExpo",
            }),
          );
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.1 },
    );
    el.querySelectorAll("[data-reveal]").forEach((i) => io.observe(i));
    return () => {
      io.disconnect();
      running.forEach((a) => a.pause());
    };
  }, [root, enabled]);
}

/** A number that counts up to `to` the first time it is on screen. */
export function CountUp({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const counter = { v: 0 };
    let anim: JSAnimation | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        anim = animate(counter, {
          v: to,
          duration: 1800,
          ease: "outExpo",
          onUpdate: () => {
            el.textContent = `${Math.round(counter.v)}${suffix}`;
          },
        });
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      anim?.pause();
    };
  }, [to, suffix]);
  return (
    <span ref={ref}>
      {to}
      {suffix}
    </span>
  );
}

/** Tilts toward the pointer and springs back on leave; a light follows the pointer across the face. */
export function TiltCard({
  children,
  className,
  max = 9,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const face = useRef<HTMLDivElement>(null);
  const spring = useRef<JSAnimation | null>(null);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = face.current;
    if (!el || e.pointerType === "touch" || prefersReducedMotion()) return;
    spring.current?.pause();
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    utils.set(el, { rotateX: (0.5 - py) * max, rotateY: (px - 0.5) * max });
  };
  const leave = () => {
    const el = face.current;
    if (!el || prefersReducedMotion()) return;
    spring.current = animate(el, {
      rotateX: 0,
      rotateY: 0,
      ease: createSpring({ stiffness: 90, damping: 9 }),
    });
  };

  return (
    <div className="[perspective:900px]" onPointerMove={move} onPointerLeave={leave}>
      <div
        ref={face}
        className={cn(
          "group relative h-full [transform-style:preserve-3d] [--mx:50%] [--my:50%]",
          className,
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(260px circle at var(--mx) var(--my), oklch(1 0 0 / 0.09), transparent 70%)",
          }}
        />
        {children}
      </div>
    </div>
  );
}
