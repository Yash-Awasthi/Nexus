// SPDX-License-Identifier: Apache-2.0
/**
 * The navigation offers every page that earns its place and nothing else.
 *
 * These assertions read the real source rather than rendering, because what
 * they pin is structural: removed pages stay removed, every page has a way in,
 * and the sidebar links nothing that is not registered.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

const appDir = path.resolve(__dirname, "../app");
const read = (p: string) => fs.readFileSync(path.join(appDir, p), "utf8");

/** Toy, duplicate or one-off pages. Techniques that matter live inside /chat now. */
const REMOVED = [
  "/god-mode",
  "/gauntlet",
  "/blind-council",
  "/echo-chamber",
  "/council-checkpoints",
  "/member-evolution",
  "/negation",
  "/simulation",
  "/what-if",
  "/honesty",
  "/verifiable",
  "/reasoning",
  "/prompt-filter",
  "/redteam",
  "/drift",
  "/token-conservation",
  "/verbosity",
  "/specialisation",
  "/skill-selection",
  "/cross-memory",
  "/codegen",
  "/craft",
  "/sop",
  "/interrupt-resume",
  "/agents",
  "/ab-compare",
  "/prediction-markets",
  "/rlhf",
  "/phantom",
  "/playground",
  "/conductor",
  "/task-routing",
  "/rss",
  "/evals",
  "/evaluation",
  "/image-gen",
  "/image-transform",
  "/video-transcript",
  "/voice",
  "/extraction",
  "/usage",
  "/billing",
  "/build",
  "/contacts",
  "/fine-tune",
  "/session-graph",
  "/stm",
  "/intel",
  "/repos",
  "/rooms",
  "/scrape",
  "/web-search",
  "/quality",
  "/semantic-cache",
  "/fallback-chains",
  "/language-models",
  "/about",
  "/careers",
  "/contact",
  "/pricing",
  "/llm-leaderboard",
  "/infra-calculator",
  "/product/council",
];

/** Reached from inside another page rather than the sidebar. */
const SUBROUTES = [
  "/chat/:id",
  "/live/:id",
  "/invitations/:token",
  "/connectors/onboarding",
  "/profile",
  "/setup",
];
const PUBLIC = ["/", "/login", "/register", "/status"];

/** Paths the sidebar links to, read out of the navGroups literal in root.tsx. */
function sidebarPaths(): string[] {
  const root = read("root.tsx");
  const nav = root.slice(root.indexOf("const navGroups"), root.indexOf("export function Layout"));
  return [...nav.matchAll(/\{ to: "([^"]+)"/g)].map((m) => m[1] as string);
}

/** Every path registered in routes.ts, including the index. */
function registeredPaths(): string[] {
  const src = read("routes.ts");
  const routes = [...src.matchAll(/route\(\s*"([^"]*)"/g)].map((m) => `/${m[1] as string}`);
  return ["/", ...routes];
}

describe("sidebar", () => {
  it("leads with home and the deliberation surfaces", () => {
    expect(sidebarPaths().slice(0, 4)).toEqual([
      "/dashboard",
      "/chat",
      "/discussion",
      "/archetypes",
    ]);
  });

  it("links every registered page that has no other way in", () => {
    const linked = new Set([...sidebarPaths(), ...SUBROUTES, ...PUBLIC]);
    expect(registeredPaths().filter((p) => !linked.has(p))).toEqual([]);
  });

  it("links every sidebar entry to a registered route", () => {
    const registered = new Set(registeredPaths());
    expect(sidebarPaths().filter((p) => !registered.has(p))).toEqual([]);
  });
});

describe("removed pages", () => {
  it("are neither registered, linked nor left on disk", () => {
    const registered = new Set(registeredPaths());
    const linked = new Set(sidebarPaths());
    for (const gone of REMOVED) {
      expect(registered.has(gone), gone).toBe(false);
      expect(linked.has(gone), gone).toBe(false);
      const file = `routes/${gone.slice(1).replace(/\//g, ".")}.tsx`;
      expect(fs.existsSync(path.join(appDir, file)), file).toBe(false);
    }
  });
});

describe("discussion", () => {
  it("is registered and drives the discussion endpoint", () => {
    expect(registeredPaths()).toContain("/discussion");
    expect(read("routes/discussion.tsx")).toContain("/api/v1/discussion/stream");
  });

  it("takes its participants from the same council as the debate", () => {
    expect(read("routes/discussion.tsx")).toContain("syncCouncilFromServer");
  });
});

describe("removed features", () => {
  it("leave no route, nav link, store or old product name behind", () => {
    const routes = read("routes.ts");
    const nav = read("root.tsx");
    for (const gone of ["autopilot", "blog", "api.auth", "api.deliberate", "api.evaluate"])
      expect(routes.toLowerCase()).not.toContain(gone);
    expect(nav.toLowerCase()).not.toContain("autopilot");
    expect(fs.existsSync(path.join(appDir, "lib/autopilot.ts"))).toBe(false);
    const sources = fs
      .readdirSync(appDir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .map((f) => read(f));
    expect(sources.filter((s) => /autopilot|JUDICA|intelligence-hub/i.test(s))).toEqual([]);
  });
});

describe("internal links", () => {
  it("point only at registered pages", () => {
    const registered = registeredPaths().map(
      (p) => new RegExp(`^${p.replace(/:[a-z]+/gi, "[^/]+")}$`),
    );
    const bad: string[] = [];
    for (const f of fs.readdirSync(appDir, { recursive: true, encoding: "utf8" })) {
      if (!f.endsWith(".tsx")) continue;
      const src = read(f);
      const links = src.matchAll(
        /(?:\b(?:to|href)=\{?["`]|navigate\(["`]|\b(?:to|href|link): ["`])(\/[a-z][a-z0-9/.-]*)/g,
      );
      for (const m of links) {
        const link = (m[1] as string).replace(/\/$/, "/x");
        if (link.startsWith("/api/") || link.includes(".") || registered.some((r) => r.test(link)))
          continue;
        bad.push(`${f}: ${link}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
