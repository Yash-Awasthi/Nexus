// SPDX-License-Identifier: Apache-2.0
import { animate } from "animejs";
import { RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "./motion";

import { cn } from "~/lib/utils";

interface Example {
  label: string;
  question: string;
  members: { persona: string; model: string; color: string; agrees: boolean; text: string }[];
  verdict: string;
  dissent: string;
}

const EXAMPLES: Example[] = [
  {
    label: "Kubernetes?",
    question: "Should our five-person startup adopt Kubernetes?",
    members: [
      {
        persona: "The Contrarian",
        model: "Groq · gpt-oss-120b",
        color: "#ff7a59",
        agrees: false,
        text: "What if Kubernetes is the cheap option? Managed clusters remove a later migration.",
      },
      {
        persona: "The Empiricist",
        model: "Gemini · Flash",
        color: "#3fd0e0",
        agrees: true,
        text: "Small teams lose real hours to cluster upkeep. Until load demands it, the evidence says wait.",
      },
      {
        persona: "The Pragmatist",
        model: "Mistral · Small",
        color: "#fbbf24",
        agrees: true,
        text: "Ship on a PaaS now. Revisit when you run more than a handful of services.",
      },
    ],
    verdict: "Not yet. Use a managed platform and write down the trigger for moving.",
    dissent: "The Contrarian dissents on cost.",
  },
  {
    label: "Rewrite in Rust?",
    question: "Should we rewrite the billing service in Rust?",
    members: [
      {
        persona: "The Architect",
        model: "Anthropic · Sonnet",
        color: "#7c83ff",
        agrees: false,
        text: "The boundary is clean and the service is small. A rewrite behind the same interface is contained.",
      },
      {
        persona: "The Empiricist",
        model: "Gemini · Flash",
        color: "#3fd0e0",
        agrees: true,
        text: "Nothing shows the current service is slow. Profile first; rewrites are where schedules go to die.",
      },
      {
        persona: "The Historian",
        model: "Mistral · Small",
        color: "#f472b6",
        agrees: true,
        text: "Money code that works is rarely worth touching. Wrap it in tests and leave it alone.",
      },
    ],
    verdict: "No. Profile and add tests; rewrite only if a measured limit forces it.",
    dissent: "The Architect would try it behind the interface.",
  },
  {
    label: "Hire a designer?",
    question: "Is it worth hiring a designer before product-market fit?",
    members: [
      {
        persona: "The Futurist",
        model: "OpenAI · mini",
        color: "#c084fc",
        agrees: true,
        text: "Early taste compounds. One good designer sets a bar every later hire is measured against.",
      },
      {
        persona: "The Pragmatist",
        model: "Groq · gpt-oss-20b",
        color: "#fbbf24",
        agrees: true,
        text: "Contract one for a month. You get the bar without the payroll before you know what to build.",
      },
      {
        persona: "The Minimalist",
        model: "Mistral · Small",
        color: "#6ee7a8",
        agrees: false,
        text: "Before fit, every hour on polish is an hour not spent on learning. Use a component kit.",
      },
    ],
    verdict: "Yes, as a contractor. Buy the taste now, skip the headcount until fit.",
    dissent: "The Minimalist would spend nothing yet.",
  },
];

const CPS = { question: 55, member: 95, verdict: 110 };

/** Types `text` into `el` at `cps` characters a second; resolves early, silently, once `live()` is false. */
function typeInto(el: HTMLElement, text: string, cps: number, live: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const counter = { n: 0 };
    animate(counter, {
      n: text.length,
      duration: Math.max(200, (text.length / cps) * 1000),
      ease: "linear",
      onUpdate: (self) => {
        if (!live()) {
          self.pause();
          resolve();
          return;
        }
        el.textContent = text.slice(0, Math.round(counter.n));
      },
      onComplete: () => resolve(),
    });
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A scripted council deliberation that plays itself; no model is called. */
export function DeliberationDemo() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const questionEl = useRef<HTMLParagraphElement>(null);
  const cardEls = useRef<(HTMLDivElement | null)[]>([]);
  const textEls = useRef<(HTMLParagraphElement | null)[]>([]);
  const dotEls = useRef<(HTMLSpanElement | null)[]>([]);
  const verdictBox = useRef<HTMLDivElement>(null);
  const verdictEl = useRef<HTMLParagraphElement>(null);
  const dissentEl = useRef<HTMLParagraphElement>(null);
  const run = useRef(0);
  const example = EXAMPLES[index]!;

  const reset = useCallback(() => {
    if (questionEl.current) questionEl.current.textContent = "";
    textEls.current.forEach((t) => t && (t.textContent = ""));
    cardEls.current.forEach((c) => c && (c.style.opacity = "0.18"));
    dotEls.current.forEach((d, i) => d && (d.style.left = `${16 + i * 34}%`));
    if (verdictBox.current) verdictBox.current.style.opacity = "0.18";
    if (verdictEl.current) verdictEl.current.textContent = "";
    if (dissentEl.current) dissentEl.current.style.opacity = "0";
  }, []);

  const play = useCallback(
    async (ex: Example) => {
      const id = ++run.current;
      const live = () => run.current === id;
      reset();

      if (prefersReducedMotion()) {
        if (questionEl.current) questionEl.current.textContent = ex.question;
        textEls.current.forEach((t, i) => t && (t.textContent = ex.members[i]!.text));
        cardEls.current.forEach((c) => c && (c.style.opacity = "1"));
        if (verdictBox.current) verdictBox.current.style.opacity = "1";
        if (verdictEl.current) verdictEl.current.textContent = ex.verdict;
        if (dissentEl.current) dissentEl.current.style.opacity = "1";
        dotEls.current.forEach(
          (d, i) => d && (d.style.left = ex.members[i]!.agrees ? "70%" : "20%"),
        );
        return;
      }

      setPlaying(true);
      await typeInto(questionEl.current!, ex.question, CPS.question, live);
      for (let i = 0; i < ex.members.length; i++) {
        if (!live()) return;
        const card = cardEls.current[i]!;
        animate(card, { opacity: 1, translateY: [14, 0], duration: 500, ease: "outExpo" });
        await wait(280);
        await typeInto(textEls.current[i]!, ex.members[i]!.text, CPS.member, live);
      }
      if (!live()) return;
      ex.members.forEach((m, i) =>
        animate(dotEls.current[i]!, {
          left: m.agrees ? `${66 + i * 5}%` : "20%",
          duration: 1400,
          ease: "inOutExpo",
        }),
      );
      await wait(700);
      if (!live()) return;
      animate(verdictBox.current!, {
        opacity: 1,
        translateY: [10, 0],
        duration: 600,
        ease: "outExpo",
      });
      await typeInto(verdictEl.current!, ex.verdict, CPS.verdict, live);
      if (!live()) return;
      animate(dissentEl.current!, { opacity: [0, 1], duration: 700, ease: "outQuad" });
      setPlaying(false);
    },
    [reset],
  );

  // Start when first scrolled to, and again whenever another question is picked.
  const started = useRef(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (started.current) {
      void play(EXAMPLES[index]!);
      return;
    }
    reset();
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        started.current = true;
        void play(EXAMPLES[index]!);
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
    // `index` re-runs this on a new pick; `play` and `reset` are stable.
  }, [index, play, reset]);

  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  return (
    <div ref={root} className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_1fr] lg:items-start">
      <div className="flex flex-wrap gap-2 lg:flex-col" role="group" aria-label="Example questions">
        <p className="w-full font-mono text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
          Pick a question
        </p>
        {EXAMPLES.map((ex, i) => (
          <button
            key={ex.label}
            type="button"
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            className={cn(
              "rounded-md border px-3.5 py-2 text-left text-sm transition-colors",
              i === index
                ? "border-primary/60 bg-primary/15 text-foreground"
                : "border-white/10 bg-white/[0.03] text-muted-foreground hover:border-white/25 hover:text-foreground",
            )}
          >
            {ex.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void play(example)}
          disabled={playing}
          className="mt-1 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" /> Replay
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10 bg-background/70 shadow-2xl shadow-black/40 backdrop-blur-md">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-success" /> Example deliberation
          </span>
          <span>scripted · no model called</span>
        </div>

        <div className="space-y-3 p-4 sm:p-5" aria-hidden="true">
          <div className="flex justify-end">
            <p className="min-h-9 max-w-[88%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
              <span ref={questionEl} />
              <span className="ml-px inline-block h-4 w-px translate-y-0.5 bg-current [animation:caret_1s_steps(1)_infinite]" />
            </p>
          </div>

          {example.members.map((m, i) => (
            <div
              key={`${index}-${m.persona}`}
              ref={(el) => {
                cardEls.current[i] = el;
              }}
              className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
              style={{ opacity: 0.18 }}
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="size-2 rounded-full" style={{ background: m.color }} />
                <span className="font-medium">{m.persona}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {m.model}
                </span>
              </div>
              <p
                ref={(el) => {
                  textEls.current[i] = el;
                }}
                className="mt-1.5 min-h-[2.6rem] text-sm text-muted-foreground"
              />
            </div>
          ))}

          <div className="rounded-lg border border-white/10 p-3">
            <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Positions
            </p>
            <div className="relative mt-3 h-6">
              <span className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
              {example.members.map((m, i) => (
                <span
                  key={`${index}-${m.persona}-dot`}
                  ref={(el) => {
                    dotEls.current[i] = el;
                  }}
                  className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-background"
                  style={{ background: m.color, left: `${16 + i * 34}%` }}
                />
              ))}
            </div>
          </div>

          <div
            ref={verdictBox}
            className="rounded-lg border border-primary/40 bg-primary/10 p-3"
            style={{ opacity: 0.18 }}
          >
            <p className="flex items-center gap-1.5 text-xs font-semibold">
              <Sparkles className="size-3.5 text-primary" />
              Synthesis · {example.members.filter((m) => m.agrees).length} of{" "}
              {example.members.length} converged
            </p>
            <p ref={verdictEl} className="mt-1.5 min-h-5 text-sm" />
            <p
              ref={dissentEl}
              className="mt-1 text-xs text-muted-foreground"
              style={{ opacity: 0 }}
            >
              {example.dissent}
            </p>
          </div>
        </div>

        <div className="sr-only">
          <p>{example.question}</p>
          {example.members.map((m) => (
            <p key={m.persona}>
              {m.persona}: {m.text}
            </p>
          ))}
          <p>
            Synthesis: {example.verdict} {example.dissent}
          </p>
        </div>
      </div>
    </div>
  );
}
