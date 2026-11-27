// SPDX-License-Identifier: Apache-2.0
/**
 * Coach marks are remembered state, so the tests are about the remembering: shown once, keyed
 * per user and per page, and never shown when the store cannot record the dismissal.
 *
 * The last point is the one worth arguing for. If `localStorage` throws — private mode, a full
 * quota, a blocked origin — a hint that cannot be remembered would reappear on every visit. A
 * dismissible banner that is not actually dismissible is worse than no banner, so the failure
 * mode is chosen: stay hidden.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  COACH_MARKS,
  COACH_PREFIX,
  coachKey,
  coachMarkFor,
  dismissCoachMark,
  isDismissed,
  pendingCoachMark,
  type CoachStore,
} from "../app/lib/coach-marks.ts";
import { allNavItems } from "../app/lib/nav.ts";

/** A minimal localStorage stand-in: values, and a switch to make every call throw. */
function store(opts: { broken?: boolean } = {}): CoachStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      if (opts.broken) throw new Error("storage blocked");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (opts.broken) throw new Error("storage blocked");
      data.set(key, value);
    },
  };
}

describe("the hint registry", () => {
  it("only names pages that exist in the navigation", () => {
    const pages = new Set(allNavItems().map((item) => item.to));
    for (const mark of COACH_MARKS) {
      expect(pages.has(mark.page), `${mark.page} is not a nav route`).toBe(true);
    }
  });

  it("has one hint per page and no duplicate copy", () => {
    const pages = COACH_MARKS.map((mark) => mark.page);
    expect(new Set(pages).size).toBe(pages.length);
    const titles = COACH_MARKS.map((mark) => mark.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("says something short enough to read and specific enough to be worth reading", () => {
    for (const mark of COACH_MARKS) {
      expect(mark.title.length, mark.page).toBeLessThanOrEqual(60);
      expect(mark.body.length, mark.page).toBeLessThanOrEqual(240);
      // A hint that restates the page title teaches nothing.
      expect(mark.body.toLowerCase(), mark.page).not.toBe(mark.title.toLowerCase());
    }
  });

  it("is wired into the page it describes, not just registered", () => {
    // The registry and the pages are two files; this is the link between them.
    const wired: Record<string, string> = {
      "/knowledge": "apps/ui/app/routes/knowledge.tsx",
      "/workflows": "apps/ui/app/routes/workflows.tsx",
      "/templates": "apps/ui/app/routes/templates.tsx",
      "/knowledge-graph": "apps/ui/app/routes/knowledge-graph.tsx",
      "/costs": "apps/ui/app/routes/costs.tsx",
      "/sandbox": "apps/ui/app/routes/sandbox.tsx",
    };
    for (const mark of COACH_MARKS) {
      const file = wired[mark.page];
      expect(file, `${mark.page} has no page component in this test`).toBeDefined();
      const source = fs.readFileSync(path.resolve(__dirname, "../../..", file!), "utf8");
      expect(source, `${file} renders no coach mark`).toContain(
        `<CoachMark page="${mark.page}" />`,
      );
    }
  });
});

describe("showing it once", () => {
  it("is pending on the first visit and gone after dismissal", () => {
    const s = store();
    expect(pendingCoachMark("/knowledge", "u1", s)?.title).toBe(coachMarkFor("/knowledge")!.title);
    dismissCoachMark("/knowledge", "u1", s);
    expect(pendingCoachMark("/knowledge", "u1", s)).toBeUndefined();
    expect(isDismissed("/knowledge", "u1", s)).toBe(true);
  });

  it("keeps users apart, so a second account on this browser still gets the tour", () => {
    const s = store();
    dismissCoachMark("/workflows", "alice", s);
    expect(pendingCoachMark("/workflows", "alice", s)).toBeUndefined();
    expect(pendingCoachMark("/workflows", "bob", s)).toBeDefined();
    // An unauthenticated browser is its own bucket, not everybody's.
    expect(pendingCoachMark("/workflows", null, s)).toBeDefined();
    expect(pendingCoachMark("/workflows", undefined, s)).toBeDefined();
    expect(coachKey("/workflows", null)).toBe(`${COACH_PREFIX}.anonymous./workflows`);
  });

  it("keeps pages apart: dismissing one hint does not end the tour", () => {
    const s = store();
    dismissCoachMark("/costs", "u1", s);
    expect(pendingCoachMark("/costs", "u1", s)).toBeUndefined();
    expect(pendingCoachMark("/sandbox", "u1", s)).toBeDefined();
  });

  it("has no hint for a page that is not in the registry", () => {
    expect(pendingCoachMark("/settings", "u1", store())).toBeUndefined();
    expect(coachMarkFor("/settings")).toBeUndefined();
  });

  it("stays hidden when the dismissal cannot be stored", () => {
    const broken = store({ broken: true });
    expect(isDismissed("/knowledge", "u1", broken)).toBe(true);
    expect(pendingCoachMark("/knowledge", "u1", broken)).toBeUndefined();
    // And dismissing must not throw into a render.
    expect(() => dismissCoachMark("/knowledge", "u1", broken)).not.toThrow();
  });

  it("writes only the key it owns", () => {
    const s = store();
    dismissCoachMark("/templates", "u1", s);
    expect([...s.data.keys()]).toEqual([coachKey("/templates", "u1")]);
  });
});
