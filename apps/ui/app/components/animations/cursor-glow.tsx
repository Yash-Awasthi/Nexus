"use client";

import { useEffect, useRef, useCallback } from "react";

export function CursorGlow({ className }: { className?: string }) {
  const glowRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef({ x: 0, y: 0 });
  const currentRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number>(0);
  const activeRef = useRef(false);

  const animate = useCallback(() => {
    const dx = positionRef.current.x - currentRef.current.x;
    const dy = positionRef.current.y - currentRef.current.y;

    currentRef.current.x += dx * 0.15;
    currentRef.current.y += dy * 0.15;

    if (glowRef.current) {
      glowRef.current.style.transform = `translate(${currentRef.current.x - 200}px, ${currentRef.current.y - 200}px)`;
    }

    if (activeRef.current) {
      rafRef.current = requestAnimationFrame(animate);
    }
  }, []);

  useEffect(() => {
    // Only activate on desktop (no coarse pointer / has fine pointer)
    const isDesktop = window.matchMedia("(pointer: fine)").matches;
    if (!isDesktop) return;

    activeRef.current = true;

    const handleMouseMove = (e: MouseEvent) => {
      positionRef.current = { x: e.clientX, y: e.clientY };
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      activeRef.current = false;
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(rafRef.current);
    };
  }, [animate]);

  return (
    <div
      className={`fixed inset-0 pointer-events-none z-50 overflow-hidden hidden md:block ${className ?? ""}`}
    >
      <div
        ref={glowRef}
        className="w-[400px] h-[400px] rounded-full will-change-transform"
        style={{
          background:
            "radial-gradient(circle, rgba(99,102,241,0.07) 0%, rgba(139,92,246,0.04) 40%, transparent 70%)",
          transform: "translate(-400px, -400px)",
        }}
      />
    </div>
  );
}
