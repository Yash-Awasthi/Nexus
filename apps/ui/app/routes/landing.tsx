// SPDX-License-Identifier: Apache-2.0
import { animate, onScroll, splitText, stagger } from "animejs";
import {
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  EyeOff,
  GitFork,
  HardDrive,
  KeyRound,
  Scale,
  Swords,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/landing";

import { DeliberationDemo } from "~/components/landing/deliberation-demo";
import { CountUp, TiltCard, prefersReducedMotion, useReveal } from "~/components/landing/motion";
import { SceneCanvas } from "~/components/landing/scene-canvas";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Nexus — a council of AI models that argue before they answer" },
    {
      name: "description",
      content:
        "Put a question to several models at once, each speaking as a different archetype. They debate, a chair writes the synthesis, and a company of agents can act on it.",
    },
  ];
}

const RAIL = [
  ["hero", "Start"],
  ["seat", "Seat"],
  ["argue", "Argue"],
  ["synthesis", "Synthesise"],
  ["work", "Act"],
  ["demo", "Watch"],
  ["features", "Features"],
  ["local", "Desktop"],
  ["closing", "Begin"],
] as const;

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const [calm] = useState(() => prefersReducedMotion());
  const [section, setSection] = useState("hero");
  useReveal(root, !calm);

  return (
    <div
      ref={root}
      className={cn("landing relative isolate overflow-x-clip", !calm && "landing-reveal-init")}
    >
      <Backdrop />
      <SceneCanvas onSection={setSection} />
      <ProgressBar />
      <SectionRail active={section} />
      <div className="relative z-10">
        <Hero calm={calm} />
        <Providers />
        <Stage
          scene="seat"
          index="01"
          eyebrow="Seat the council"
          icon={Users}
          title={
            <>
              Choose who <em>sits at the table</em>
            </>
          }
          body="Pick the models and the archetype each one speaks as, or let Nexus pick the personas that fit the question. Every member runs on a different model, so they do not share a blind spot."
          chips={[
            "Architect",
            "Contrarian",
            "Empiricist",
            "Ethicist",
            "Futurist",
            "Pragmatist",
            "Historian",
            "+ 7 more, or write your own",
          ]}
        />
        <Stage
          scene="argue"
          index="02"
          eyebrow="Let them argue"
          icon={Swords}
          title={
            <>
              They answer, read each other, <em>and push back</em>
            </>
          }
          body="Members answer on their own, read the others and refine. Choose red vs blue, Socratic, competing hypotheses or confidence-scored, and hide who said what until you reveal it."
          chips={[
            "Red vs blue",
            "Socratic",
            "Competing hypotheses",
            "Confidence-scored",
            "Blind review",
          ]}
        />
        <Stage
          scene="synthesis"
          index="03"
          eyebrow="Read the synthesis"
          icon={Scale}
          title={
            <>
              One answer, with <em>the dissent left in</em>
            </>
          }
          body="A chair writes the recommendation, where the council agrees, where it splits and who stands where, and what would settle it. The member who disagreed is named, not averaged away."
          chips={["Recommendation", "Where it agrees", "Where it splits", "What would settle it"]}
        />
        <Stage
          scene="work"
          index="04"
          eyebrow="Turn it into work"
          icon={Building2}
          title={
            <>
              Hand the verdict to <em>a company of agents</em>
            </>
          }
          body="Send a verdict to one of your companies. A CEO agent and a team plan the tasks, stay inside budget, and ask you before anything risky. Runs are scheduled, logged and replayable."
          chips={["Org chart", "Budgets with hard stops", "Approvals inbox", "Scheduled runs"]}
        />
        <Demo />
        <Features />
        <Local />
        <Closing />
      </div>
    </div>
  );
}

/** What the page shows before the 3D scene loads, or when there is no WebGL. */
function Backdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10"
      style={{
        background:
          "radial-gradient(60rem 40rem at 78% 18%, oklch(0.42 0.18 275 / 0.28), transparent 60%), radial-gradient(50rem 36rem at 12% 90%, oklch(0.5 0.16 20 / 0.12), transparent 60%), linear-gradient(180deg, oklch(0.13 0.02 270), oklch(0.11 0.015 265))",
      }}
    />
  );
}

/** A hairline along the top edge that fills as the page is read. */
function ProgressBar() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || prefersReducedMotion()) return;
    const anim = animate(el, {
      scaleX: [0, 1],
      ease: "linear",
      autoplay: onScroll({ sync: true }),
    });
    return () => {
      anim.revert();
    };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5">
      <div ref={bar} className="h-full origin-left scale-x-0 bg-primary" />
    </div>
  );
}

/** Dots down the right edge, one per scene; the lit one follows the scroll. */
function SectionRail({ active }: { active: string }) {
  return (
    <nav
      aria-label="Page sections"
      className="fixed top-1/2 right-4 z-30 hidden -translate-y-1/2 flex-col gap-3 xl:flex"
    >
      {RAIL.map(([key, label]) => (
        <a
          key={key}
          href={`#${key}`}
          aria-label={label}
          aria-current={active === key ? "true" : undefined}
          onClick={(e) => {
            e.preventDefault();
            document
              .querySelector(`[data-scene="${key}"]`)
              ?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
          }}
          className="group flex items-center justify-end gap-2"
        >
          <span
            className={cn(
              "font-mono text-[10px] tracking-[0.16em] uppercase opacity-0 transition-opacity group-hover:opacity-100",
              active === key ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              "block rounded-full transition-all",
              active === key
                ? "h-5 w-1.5 bg-primary"
                : "size-1.5 bg-white/25 group-hover:bg-white/60",
            )}
          />
        </a>
      ))}
    </nav>
  );
}

function Hero({ calm }: { calm: boolean }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = title.current;
    if (!el) return;
    if (calm) {
      el.style.visibility = "visible";
      return;
    }
    const split = splitText(el, { words: { wrap: "clip" } });
    el.style.visibility = "visible";
    const anim = animate(split.words, {
      translateY: ["112%", "0%"],
      duration: 1200,
      delay: stagger(80, { start: 120 }),
      ease: "outExpo",
    });
    return () => {
      anim.pause();
      split.revert();
    };
  }, [calm]);

  return (
    <section
      data-scene="hero"
      id="hero"
      className="relative flex min-h-svh items-end sm:items-center"
    >
      <div className="mx-auto w-full max-w-6xl px-4 pt-24 pb-10 sm:px-6 sm:pb-32">
        <div className="max-w-[46rem]">
          <p
            data-reveal
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1 font-mono text-[11px] tracking-[0.16em] text-muted-foreground uppercase backdrop-blur"
          >
            <span className="size-1.5 rounded-full bg-success" /> Open source · bring your own keys
          </p>
          <h1
            ref={title}
            style={{ visibility: "hidden" }}
            className="mt-6 font-display text-[clamp(3rem,7.6vw,6.4rem)] leading-[0.95] font-normal tracking-tight"
          >
            One question.
            <br />
            Several minds.
            <em className="mt-5 block max-w-[30ch] text-[0.4em] leading-[1.12] tracking-normal text-primary italic">
              An answer that survived the argument.
            </em>
          </h1>
          <p
            data-reveal
            data-delay="500"
            className="mt-7 max-w-xl text-base text-muted-foreground sm:text-lg"
          >
            Nexus seats a council of models, each speaking as an archetype like the Contrarian or
            the Empiricist. They answer, read each other, refine, and a chair writes the synthesis
            with the disagreements left in. Then a company of agents can turn it into work.
          </p>
          <div data-reveal data-delay="650" className="mt-9 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link to="/register">
                Start a council <ArrowRight />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 border-white/20 bg-white/[0.04] px-6 text-base backdrop-blur"
            >
              <a href="#demo">Watch one deliberate</a>
            </Button>
          </div>
          <ul
            data-reveal
            data-delay="800"
            className="mt-10 hidden max-w-xl gap-x-6 gap-y-2 font-mono text-xs text-muted-foreground sm:grid sm:grid-cols-2"
          >
            {[
              "Groq · Gemini · Mistral · OpenAI · Anthropic",
              "Local models through Ollama",
              "Desktop app keeps everything on your machine",
              "Free. You pay your providers directly",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-primary" /> {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <a
        href="#seat"
        aria-label="Scroll to how it works"
        className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 font-mono text-[10px] tracking-[0.24em] text-muted-foreground uppercase sm:flex"
      >
        Scroll
        <span className="h-10 w-px bg-gradient-to-b from-white/50 to-transparent [animation:drift_2.4s_ease-in-out_infinite]" />
      </a>
    </section>
  );
}

const PROVIDERS = [
  "Groq",
  "Gemini",
  "Mistral",
  "OpenAI",
  "Anthropic",
  "DeepSeek",
  "OpenRouter",
  "Ollama",
  "LM Studio",
  "Together",
  "Fireworks",
  "Cerebras",
  "xAI",
  "Perplexity",
  "Cohere",
  "NVIDIA NIM",
];

function Providers() {
  const row = [...PROVIDERS, ...PROVIDERS];
  return (
    <section
      aria-label="Providers Nexus speaks to"
      className="relative overflow-hidden border-y border-white/10 bg-background/40 py-5 backdrop-blur-sm [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]"
    >
      <div className="landing-marquee flex w-max gap-12 whitespace-nowrap [animation:marquee_46s_linear_infinite]">
        {row.map((p, i) => (
          <span
            key={`${p}-${i}`}
            aria-hidden={i >= PROVIDERS.length}
            className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase"
          >
            {p}
          </span>
        ))}
      </div>
    </section>
  );
}

function Stage({
  scene,
  index,
  eyebrow,
  icon: Icon,
  title,
  body,
  chips,
}: {
  scene: string;
  index: string;
  eyebrow: string;
  icon: typeof Users;
  title: React.ReactNode;
  body: string;
  chips: string[];
}) {
  return (
    <section
      data-scene={scene}
      id={scene}
      className="relative flex min-h-[92svh] items-end lg:items-center"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="max-w-md rounded-xl border border-white/10 bg-background/55 p-6 backdrop-blur-md sm:p-7 lg:max-w-[30rem]">
          <p
            data-reveal
            className="flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-primary uppercase"
          >
            <Icon className="size-4" /> {index} / 04 · {eyebrow}
          </p>
          <h2
            data-reveal
            data-delay="100"
            className="mt-4 font-display text-[clamp(2.1rem,4.4vw,3.4rem)] leading-[1.03] font-normal [&_em]:text-primary [&_em]:italic"
          >
            {title}
          </h2>
          <p data-reveal data-delay="200" className="mt-4 text-muted-foreground">
            {body}
          </p>
          <ul data-reveal data-delay="300" className="mt-6 flex flex-wrap gap-2">
            {chips.map((c) => (
              <li
                key={c}
                className="rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 font-mono text-[11px] text-muted-foreground"
              >
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Demo() {
  return (
    <section data-scene="demo" id="demo" className="relative">
      <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
        <div className="max-w-2xl">
          <p data-reveal className="font-mono text-[11px] tracking-[0.2em] text-primary uppercase">
            See it think
          </p>
          <h2
            data-reveal
            data-delay="100"
            className="mt-4 font-display text-[clamp(2.4rem,5vw,4rem)] leading-[1.02] font-normal [&_em]:text-primary [&_em]:italic"
          >
            Disagreement is <em>the feature</em>
          </h2>
          <p data-reveal data-delay="200" className="mt-4 text-muted-foreground">
            A single model agrees with itself. A council shows you the strongest objections before
            you commit. Pick a question and watch three members take it apart.
          </p>
        </div>
        <div data-reveal data-delay="150" className="mt-12">
          <DeliberationDemo />
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    icon: Users,
    title: "Archetypes",
    body: "The Architect, the Contrarian, the Ethicist and more, or write your own persona with its own model and temperature.",
  },
  {
    icon: EyeOff,
    title: "Blind review and steering",
    body: "Hide who said what until you reveal it. Rule things out for a thread, or give it a domain focus every member follows.",
  },
  {
    icon: Building2,
    title: "Companies of agents",
    body: "A CEO agent and a team work through tasks on a schedule, with budgets, approvals and an inbox for what needs you.",
  },
  {
    icon: BookOpen,
    title: "Knowledge that answers back",
    body: "Knowledge bases, a knowledge graph, long-term memory, curated answers and deep research the council can cite with an @-mention.",
  },
  {
    icon: GitFork,
    title: "Workflows and skills",
    body: "Chain steps into workflows, give agents skills and MCP tools, and run code in a sandbox before it touches anything.",
  },
  {
    icon: KeyRound,
    title: "Your keys, your costs",
    body: "Every call runs on the provider keys you save, encrypted. See usage and cost per model; no markup, no subscription.",
  },
];

const NUMBERS: { to: number; suffix?: string; label: string }[] = [
  { to: 14, label: "built-in archetypes" },
  { to: 5, label: "council templates" },
  { to: 40, suffix: "+", label: "model providers" },
  { to: 30, suffix: "+", label: "knowledge connectors" },
];

function Features() {
  return (
    <section data-scene="features" id="features" className="relative">
      <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 lg:grid-cols-4">
          {NUMBERS.map((n) => (
            <div key={n.label} data-reveal className="bg-background/70 p-5 backdrop-blur-md sm:p-7">
              <dt className="order-2 mt-1 font-mono text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
                {n.label}
              </dt>
              <dd className="font-display text-5xl sm:text-6xl">
                <CountUp to={n.to} suffix={n.suffix} />
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-24 max-w-2xl">
          <p data-reveal className="font-mono text-[11px] tracking-[0.2em] text-primary uppercase">
            Features
          </p>
          <h2
            data-reveal
            data-delay="100"
            className="mt-4 font-display text-[clamp(2.4rem,5vw,4rem)] leading-[1.02] font-normal [&_em]:text-primary [&_em]:italic"
          >
            Everything around the council, <em>nothing for show</em>
          </h2>
          <p data-reveal data-delay="200" className="mt-4 text-muted-foreground">
            Each part exists to make a decision better or to act on it.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={f.title} data-reveal data-delay={(i % 3) * 90}>
              <TiltCard className="h-full rounded-xl border border-white/10 bg-background/60 p-6 backdrop-blur-md transition-colors hover:border-primary/40">
                <f.icon className="size-5 text-primary" />
                <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
              </TiltCard>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Local() {
  return (
    <section data-scene="local" id="local" className="relative">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2 lg:items-center lg:py-32">
        <div className="lg:order-2">
          <p data-reveal className="font-mono text-[11px] tracking-[0.2em] text-primary uppercase">
            Desktop
          </p>
          <h2
            data-reveal
            data-delay="100"
            className="mt-4 font-display text-[clamp(2.4rem,5vw,4rem)] leading-[1.02] font-normal [&_em]:text-primary [&_em]:italic"
          >
            Runs on <em>your machine</em>
          </h2>
          <p data-reveal data-delay="200" className="mt-4 max-w-md text-muted-foreground">
            The desktop app carries its own database and account. Point members at Ollama or LM
            Studio and nothing leaves your computer.
          </p>
          <ul data-reveal data-delay="300" className="mt-6 space-y-2 text-sm">
            {[
              "Local sign-in, no cloud account needed",
              "Local models side by side with hosted ones",
              "Sync to a web deployment only when you choose",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <div data-reveal="scale" className="lg:order-1">
          <TiltCard
            max={7}
            className="rounded-2xl border border-white/10 bg-background/60 p-6 backdrop-blur-md"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <HardDrive className="size-5" />
              </span>
              <div>
                <p className="font-medium">Local-only</p>
                <p className="text-sm text-muted-foreground">API and data on this computer</p>
              </div>
            </div>
            <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
              {[
                ["Database", "Embedded Postgres"],
                ["Models", "Ollama · LM Studio · any key"],
                ["Account", "Kept in the OS keychain"],
                ["Network", "Only the providers you use"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <dt className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                    {k}
                  </dt>
                  <dd className="mt-1 font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </TiltCard>
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section data-scene="closing" id="closing" className="relative flex min-h-svh items-center">
      <div className="mx-auto w-full max-w-6xl px-4 py-24 text-center sm:px-6">
        <div
          className="mx-auto max-w-2xl px-4 py-20"
          style={{
            background:
              "radial-gradient(closest-side, oklch(0.12 0.02 270 / 0.9) 55%, transparent)",
          }}
        >
          <h2
            data-reveal
            className="font-display text-[clamp(2.8rem,7vw,5.5rem)] leading-[0.98] font-normal [&_em]:text-primary [&_em]:italic"
          >
            Ask your first <em>council</em>
          </h2>
          <p data-reveal data-delay="150" className="mx-auto mt-5 max-w-md text-muted-foreground">
            Add one free provider key and you have a council in under a minute.
          </p>
          <div data-reveal data-delay="300" className="mt-9 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" className="h-12 px-7 text-base">
              <Link to="/register">
                Get started <ArrowRight />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 border-white/20 bg-white/[0.04] px-7 text-base backdrop-blur"
            >
              <Link to="/login">Sign in</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
