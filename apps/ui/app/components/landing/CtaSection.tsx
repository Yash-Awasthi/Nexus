import { useRef, useEffect } from "react";
import { Link } from "react-router";

export function CtaSection() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(
      ([{ default: gsap }, { ScrollTrigger }]) => {
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);

        if (ref.current) {
          gsap.fromTo(
            ref.current,
            { opacity: 0, scale: 0.95 },
            {
              opacity: 1,
              scale: 1,
              duration: 0.8,
              ease: "power2.out",
              scrollTrigger: { trigger: ref.current, start: "top 80%" },
            }
          );
        }
      }
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <div
          ref={ref}
          className="relative rounded-2xl bg-gradient-to-br from-[#4d7cff]/10 to-[#8a4dff]/10 border border-white/5 p-10 sm:p-16 text-center opacity-0"
        >
          {/* Glow */}
          <div className="absolute -inset-1 rounded-2xl bg-[#4d7cff]/5 blur-xl -z-10" />

          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Ready to Think Differently?
          </h2>
          <p className="mt-4 text-base text-white/40 max-w-md mx-auto">
            Join teams using AI deliberation to make better decisions.
          </p>
          <div className="mt-8">
            <Link
              to="/register"
              className="inline-flex items-center justify-center px-8 py-3.5 text-sm font-medium text-white bg-[#4d7cff] hover:bg-[#3d6cef] rounded-lg transition-all hover:shadow-[0_0_40px_rgba(77,124,255,0.3)]"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
