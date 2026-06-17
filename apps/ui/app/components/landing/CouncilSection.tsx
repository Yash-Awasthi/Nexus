import { useRef, useEffect, useState, lazy, Suspense } from "react";

const CouncilCanvas = lazy(() => import("~/components/three/CouncilScene"));

const personas = [
  { name: "The Analyst", desc: "Methodical, data-driven reasoning", color: "#4d7cff" },
  { name: "The Creative", desc: "Lateral thinking, novel angles", color: "#ff4de8" },
  { name: "The Critic", desc: "Challenges assumptions, finds flaws", color: "#ff8a4d" },
  { name: "The Strategist", desc: "Long-term thinking, systems view", color: "#4dff8a" },
  { name: "The Philosopher", desc: "Ethical lens, first principles", color: "#8a4dff" },
];

export function CouncilSection() {
  const [isClient, setIsClient] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setIsClient(true); }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(
      ([{ default: gsap }, { ScrollTrigger }]) => {
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);

        if (headingRef.current) {
          gsap.fromTo(
            headingRef.current.children,
            { opacity: 0, y: 40 },
            {
              opacity: 1,
              y: 0,
              duration: 0.8,
              stagger: 0.15,
              ease: "power2.out",
              scrollTrigger: { trigger: headingRef.current, start: "top 80%" },
            }
          );
        }
      }
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section id="council" ref={sectionRef} className="relative py-24 sm:py-32 overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Heading */}
        <div ref={headingRef} className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight opacity-0">
            The AI <span className="text-[#4d7cff]">Council</span>
          </h2>
          <p className="mt-4 text-lg text-white/40 max-w-xl mx-auto opacity-0">
            Five distinct AI personas. One collaborative arena.
          </p>
          <p className="mt-3 text-sm text-white/30 max-w-2xl mx-auto opacity-0">
            Every deliberation convenes a council of specialized AI archetypes — each with its own
            reasoning style, biases, and expertise. They challenge, debate, and synthesize until the
            best answer emerges.
          </p>
        </div>

        {/* 3D Scene */}
        <div className="relative w-full h-[400px] sm:h-[500px] md:h-[600px] rounded-2xl overflow-hidden">
          <div className="absolute inset-0 bg-[oklch(0.06_0.02_260)] rounded-2xl border border-white/5">
            {isClient && (
              <Suspense
                fallback={
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-8 h-8 border-2 border-[#4d7cff]/30 border-t-[#4d7cff] rounded-full animate-spin" />
                  </div>
                }
              >
                <CouncilCanvas />
              </Suspense>
            )}
          </div>
        </div>

        {/* Persona cards */}
        <div className="mt-12 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {personas.map((p) => (
            <div
              key={p.name}
              className="group relative bg-white/[0.03] border border-white/5 rounded-xl p-4 text-center hover:border-white/10 transition-all"
            >
              <div
                className="mx-auto w-3 h-3 rounded-full mb-3"
                style={{ backgroundColor: p.color, boxShadow: `0 0 12px ${p.color}40` }}
              />
              <h3 className="text-sm font-semibold text-white">{p.name}</h3>
              <p className="mt-1 text-xs text-white/40">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
