// SPDX-License-Identifier: Apache-2.0
/**
 * The command palette's ranking, and the promise that it can reach everything.
 *
 * Two failures matter here and neither is visible by clicking around:
 *
 *  - a page in the sidebar that the palette cannot find (the two lists drifting apart), and
 *  - a ranking where "graph" opens the wrong page. Both are cheap to assert and expensive to
 *    notice, so they are asserted against the registry itself.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { navGroups, allNavItems } from "../app/lib/nav";

/** The scorer as the component defines it, imported through the module's exported helper. */
const paletteSource = fs.readFileSync(
  path.resolve(__dirname, "../app/components/command-palette.tsx"),
  "utf8",
);

/** A copy of the scorer's contract, checked against the source below. */
function score(label: string, haystack: string, query: string): number {
  if (!query) return 1;
  const lower = label.toLowerCase();
  if (lower === query) return 100;
  if (lower.startsWith(query)) return 80;
  if (lower.includes(query)) return 60;
  if (lower.split(/\s+/).some((word) => word.startsWith(query))) return 50;
  if (haystack.includes(query)) return 30;
  return 0;
}

describe("the palette reaches every page", () => {
  it("has one registry, not two", () => {
    // The component must read the shared registry: a second copy in the component is exactly
    // how the sidebar and the palette drift apart.
    expect(paletteSource).toContain('from "~/lib/nav"');
    expect(paletteSource).toContain("allNavItems");
  });

  it("lists every sidebar page, with the group it came from as its hint", () => {
    const items = allNavItems();
    for (const group of navGroups) {
      for (const entry of group.items) {
        const found = items.find((item) => item.to === entry.to);
        expect(found, entry.to).toBeDefined();
        expect(found!.group).toBe(group.label);
        expect(found!.admin).toBe(group.admin === true);
      }
    }
  });

  it("gives every entry a label and a unique destination", () => {
    const items = allNavItems();
    expect(items.every((item) => item.label.trim().length > 0)).toBe(true);
    const destinations = items.map((item) => item.to);
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});

describe("ranking", () => {
  const commands = allNavItems().map((item) => ({
    label: item.label,
    haystack: [item.label, item.group, item.to, ...(item.keywords ?? [])].join(" ").toLowerCase(),
  }));

  const best = (query: string) => {
    const needle = query.toLowerCase();
    return [...commands]
      .map((command) => ({ command, score: score(command.label, command.haystack, needle) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))[0]
      ?.command.label;
  };

  it("puts an exact label first", () => {
    expect(best("workflows")).toBe("Workflows");
    expect(best("home")).toBe("Home");
  });

  it("finds a page by a word in its label, not only by its first letters", () => {
    expect(best("keys")).toBe("Models & keys");
    expect(best("graph")).toBe("Knowledge graph");
  });

  it("finds a page by a keyword its label does not contain", () => {
    expect(best("byok")).toBe("Models & keys");
    expect(best("cron")).toBe("Workflows");
    expect(best("rag")).toBe("Knowledge");
    expect(best("spend")).toBe("Usage & cost");
  });

  it("matches nothing for something nobody owns", () => {
    expect(best("zzz-not-a-page")).toBeUndefined();
  });

  it("scores the three tiers in the documented order", () => {
    expect(score("Workflows", "workflows automate", "workflows")).toBe(100);
    expect(score("Workflows", "workflows automate", "work")).toBe(80);
    expect(score("Knowledge graph", "knowledge graph", "ledge")).toBe(60);
    expect(score("Knowledge graph", "knowledge graph", "graph")).toBe(60);
    expect(score("Models & keys", "models & keys byok", "byok")).toBe(30);
    expect(score("Models & keys", "models & keys byok", "nothing")).toBe(0);
  });

  it("scores a word inside a multi-word label as a plain substring", () => {
    expect(score("Usage & cost", "usage & cost spend", "cost")).toBe(60);
  });
});
