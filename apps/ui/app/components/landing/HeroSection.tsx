import { useRef, useEffect, useState, lazy, Suspense } from "react";
import { Link } from "react-router";

const HeroCanvas = lazy(() => import("~/components/three/HeroRing"));

export function HeroSection() {
  const [isClient, setIsClient] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setIsClient(true); }, []);

  useEffect(() => {
    let cancelled = false;
    import("gsap").then(({ default: gsap }) => {
      if (cancelled) return;
      if (titleRef.current) {
        gsap.fromTo(titleRef.current, { opacity: 0, scale: 0.9, y: 30 }, { opacity: 1, scale: 1, y: 0, duration: 1.2, ease: "power3.out" });
      }
      if (subtitleRef.current) {
        gsap.fromTo(subtitleRef.current, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 1, delay: 0.3, ease: "power2.out" });
      }
      if (ctaRef.current) {
        gsap.fromTo(
          Array.from(ctaRef.current.children),
          { opacity: 0, y: 20 },
          { opacity: 1, y: 0, duration: 0.8, delay: 0.6, stagger: 0.15, ease: "power2.out" }
        );
      }
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16">
      {/* 3D Background */}
      <div className="absolute inset-0 z-0">
        {isClient && (
          <Suspense fallback={<div className="w-full h-full" />}>
            <HeroCanvas />
          </Suspense>
        )}
      </div>

      {/* Gradient overlays */}
      <div className="absolute inset-0 z-[1] bg-gradient-to-b from-[oklch(0.05_0.02_260)] via-transparent to-[oklch(0.05_0.02_260)]" />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-4xl px-4 text-center">
        <h1
          ref={titleRef}
          className="text-4xl sm:text-5xl md:text-7xl font-bold tracking-tight text-white leading-[1.1] opacity-0"
        >
          Where{" "}
          <span className="bg-gradient-to-r from-[#4d7cff] to-[#4de8ff] bg-clip-text text-transparent">
            AI Minds
          </span>{" "}
          Collide
        </h1>

        <p
          ref={subtitleRef}
          className="mt-6 text-base sm:text-lg md:text-xl text-white/50 max-w-2xl mx-auto leading-relaxed opacity-0"
        >
          JUDICA orchestrates multi-model AI deliberations — pitting diverse AI perspectives
          against each other to surface deeper insights, challenge assumptions, and reach better conclusions.
        </p>

        <div ref={ctaRef} className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            to="/register"
            className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium text-white bg-[#4d7cff] hover:bg-[#3d6cef] rounded-lg transition-all hover:shadow-[0_0_30px_rgba(77,124,255,0.3)] opacity-0"
          >
            Start a Deliberation
          </Link>
          <a
            href="#council"
            className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium text-white/70 hover:text-white border border-white/10 hover:border-white/20 rounded-lg transition-all opacity-0"
          >
            See the Council
          </a>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 animate-bounce">
        <svg className="w-5 h-5 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </div>
    </section>
  );
}
