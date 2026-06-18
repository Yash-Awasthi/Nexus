import { useRef, useEffect } from "react";

const steps = [
  {
    num: "01",
    title: "Pose Your Question",
    desc: "Submit any complex question, decision, or problem to the council. Define which archetypes should participate and how many deliberation rounds to run.",
  },
  {
    num: "02",
    title: "Watch the Debate",
    desc: "AI personas deliberate in real-time, challenging and building on each other's arguments. Each archetype brings its unique perspective and reasoning style.",
  },
  {
    num: "03",
    title: "Get the Synthesis",
    desc: "Receive a consensus answer that incorporates the strongest arguments from all perspectives, with a full audit trail of the deliberation process.",
  },
];

export function HowItWorksSection() {
  const stepsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(
      ([{ default: gsap }, { ScrollTrigger }]) => {
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);

        if (stepsRef.current) {
          const items = stepsRef.current.querySelectorAll("[data-step]");
          items.forEach((item, i) => {
            gsap.fromTo(
              item,
              { opacity: 0, x: i % 2 === 0 ? -40 : 40 },
              {
                opacity: 1,
                x: 0,
                duration: 0.7,
                ease: "power2.out",
                scrollTrigger: { trigger: item, start: "top 80%" },
              }
            );
          });
        }
      }
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section id="how-it-works" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Three Steps to{" "}
            <span className="text-[#4dff8a]">Better Decisions</span>
          </h2>
        </div>

        <div ref={stepsRef} className="relative space-y-8">
          {/* Connecting line */}
          <div className="absolute left-6 top-0 bottom-0 w-px bg-gradient-to-b from-[#4d7cff]/30 via-[#4de8ff]/20 to-transparent hidden sm:block" />

          {steps.map((step) => (
            <div
              key={step.num}
              data-step
              className="relative flex gap-6 items-start opacity-0"
            >
              <div className="relative z-10 flex-shrink-0 w-12 h-12 rounded-xl bg-[#4d7cff]/10 border border-[#4d7cff]/20 flex items-center justify-center">
                <span className="text-sm font-bold text-[#4d7cff]">{step.num}</span>
              </div>
              <div className="pt-1">
                <h3 className="text-lg font-semibold text-white">{step.title}</h3>
                <p className="mt-2 text-sm text-white/40 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
