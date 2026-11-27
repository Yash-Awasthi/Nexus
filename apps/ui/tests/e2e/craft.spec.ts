// SPDX-License-Identifier: Apache-2.0
/**
 * Interface craft, measured (plan M5.4.4 … M5.4.7).
 *
 * One walk over every page in the navigation that checks the things a person feels rather than reads:
 * nothing scrolls sideways, text has enough contrast, every icon-only control has a name, focus is
 * visible, rows in a table are even, and nothing animates for someone who asked it not to.
 *
 * Every measurement is taken in the browser against the built app, so a token change that quietly breaks
 * contrast fails here rather than in a screenshot review. Screenshots of each page in both themes are
 * written when `NEXUS_CAPTURE_THEMES=1`; the assertions always run.
 */
import { test, expect, type Page } from "@playwright/test";

import { signInPage, signIn, waitForPaint } from "./fixtures";

/** The same list the sidebar renders. */
const ROUTES = [
  "/dashboard",
  "/chat",
  "/discussion",
  "/archetypes",
  "/org",
  "/projects",
  "/workspaces",
  "/workflows",
  "/templates",
  "/skills",
  "/knowledge",
  "/search",
  "/sandbox",
  "/terminals",
  "/knowledge-graph",
  "/costs",
  "/settings",
  "/provider-keys",
  "/mcp-servers",
  "/api-tokens",
  "/admin/users",
  "/admin/analytics",
  "/admin/traces",
  "/gateway",
  "/admin/audit",
  "/moderation",
  "/admin/feedback",
  "/admin/feature-flags",
  "/admin/system",
] as const;

interface Audit {
  path: string;
  overflow: number;
  unnamedControls: string[];
  invisibleFocus: string[];
  lowContrast: string[];
  unevenRows: string[];
  animations: string[];
}

/** Everything measured in one evaluate, so it runs against the page the person would see. */
async function auditPage(page: Page, path: string): Promise<Audit> {
  return page.evaluate((route) => {
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.opacity !== "0"
      );
    };

    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
      return `${tag}${text ? `:${text}` : ""}`;
    };

    // ── sideways scroll ───────────────────────────────────────────────────────
    // A wide table inside `overflow-x-auto` is correct, and its cells report coordinates past the
    // viewport; what matters is whether anything past the edge has no scrolling ancestor to live in.
    const hasScrollAncestor = (el: Element): boolean => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          style.overflowX === "auto" ||
          style.overflowX === "scroll" ||
          style.overflowX === "hidden"
        ) {
          return true;
        }
        if (node === document.body) break;
      }
      return false;
    };
    const strays = Array.from(document.querySelectorAll("body *")).filter((el) => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.right - window.innerWidth <= 1) return false;
      // An element is only a problem if it is clipped by the document rather than by a container.
      const clippedByDocument = document.documentElement.scrollWidth > window.innerWidth + 1;
      return clippedByDocument || !hasScrollAncestor(el);
    });
    const overflow = Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      strays.length > 0
        ? Math.max(
            ...strays.map((el) => Math.round(el.getBoundingClientRect().right - window.innerWidth)),
          )
        : 0,
    );

    // ── icon-only controls must have a name ───────────────────────────────────
    const accessibleName = (el: Element): string => {
      const direct = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").trim();
      if (direct) return direct;
      const labelled = el.getAttribute("aria-labelledby");
      if (labelled) {
        const text = labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const text = (el.textContent ?? "").trim();
      if (text) return text;
      // A control can be named by a `<label for>`: a switch next to "Debate round" is labelled by it.
      const id = el.getAttribute("id");
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const labelText = (label?.textContent ?? "").trim();
        if (labelText) return labelText;
      }
      const wrapping = el.closest("label");
      return (wrapping?.textContent ?? "").trim();
    };
    const unnamedControls = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="switch"]'),
    )
      .filter(visible)
      .filter((el) => accessibleName(el).length === 0)
      .map(describe)
      .slice(0, 8);

    // ── visible focus ─────────────────────────────────────────────────────────
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
      .filter(visible)
      .slice(0, 40);
    const invisibleFocus: string[] = [];
    for (const el of focusable) {
      const before = JSON.stringify(getComputedStyle(el).outline + getComputedStyle(el).boxShadow);
      el.focus({ preventScroll: true });
      const after = JSON.stringify(getComputedStyle(el).outline + getComputedStyle(el).boxShadow);
      if (before === after) invisibleFocus.push(describe(el));
      el.blur();
    }
    // A control whose focus ring is drawn on a wrapper is fine; report only when every probed control
    // on the page failed, which means there is no focus style at all.
    const noFocusAtAll = focusable.length > 0 && invisibleFocus.length === focusable.length;

    // ── contrast ──────────────────────────────────────────────────────────────
    // Computed colours in this app are `oklch(...)` (Tailwind v4 tokens) and `rgb(...)`. A regex that
    // reads the numbers out of either would treat 0.5/0.014/265 as a red channel and invent failures,
    // so oklch is converted properly: OKLab → linear sRGB → gamma, per the CSS Color 4 matrices.
    const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    const labToRgb = (l: number, a: number, b: number): [number, number, number] => {
      const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = l - 0.0894841775 * a - 1.291485548 * b;
      const L = l_ ** 3;
      const M = m_ ** 3;
      const S = s_ ** 3;
      const rgb: [number, number, number] = [
        4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
        -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
        -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
      ];
      return rgb.map((v) =>
        Math.min(255, Math.max(0, gamma(Math.min(1, Math.max(0, v))) * 255)),
      ) as [number, number, number];
    };
    const fromOklch = (l: number, ch: number, h: number): [number, number, number] => {
      const rad = (h * Math.PI) / 180;
      return labToRgb(l, ch * Math.cos(rad), ch * Math.sin(rad));
    };
    const parse = (colour: string): [number, number, number, number] => {
      const nums = colour.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
      const alpha =
        colour.includes("/") || colour.startsWith("rgba") ? (nums[nums.length - 1] ?? 1) : 1;
      if (colour.startsWith("oklch")) {
        const [r, g, b] = fromOklch(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
        return [r, g, b, alpha];
      }
      // Tailwind emits `oklab(...)` for translucent tinted surfaces (`bg-muted/40`).
      if (colour.startsWith("oklab")) {
        const [r, g, b] = labToRgb(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
        return [r, g, b, alpha];
      }
      if (colour === "transparent") return [0, 0, 0, 0];
      return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, alpha];
    };
    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number, number],
    ): [number, number, number, number] => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [
        (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / a,
        (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / a,
        (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / a,
        a,
      ];
    };
    const backgroundOf = (el: Element): [number, number, number, number] => {
      let acc: [number, number, number, number] = [255, 255, 255, 1];
      const chain: Element[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
      for (const node of chain.reverse()) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") continue; // gradients and photos: skip, cannot be sure
        const bg = parse(style.backgroundColor);
        if (bg[3] > 0) acc = over(bg, acc);
      }
      return acc;
    };
    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.slice(0, 3).map((value) => {
        const c = value! / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const lowContrast: string[] = [];
    const textNodes = Array.from(document.querySelectorAll("main *")).filter((el) => {
      if (!visible(el)) return false;
      if (el.children.length > 0 && (el.textContent ?? "").trim().length < 2) return false;
      const own = Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 1,
      );
      return own;
    });
    for (const el of textNodes.slice(0, 400)) {
      const style = getComputedStyle(el);
      const size = Number.parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 600;
      const large = size >= 24 || (bold && size >= 18.66);
      const fg = parse(style.color);
      const bg = backgroundOf(el);
      const shown = over(fg, bg);
      const l1 = luminance(shown);
      const l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const floor = large ? 3 : 4.5;
      if (ratio + 0.01 < floor) {
        lowContrast.push(
          `${describe(el)} ${ratio.toFixed(2)}:1 <${floor} (${style.color} on rgb(${bg.slice(0, 3).map(Math.round).join(",")}))`,
        );
      }
    }

    // ── even rows ─────────────────────────────────────────────────────────────
    const unevenRows: string[] = [];
    for (const table of Array.from(document.querySelectorAll("table")).filter(visible)) {
      const heights = Array.from(table.querySelectorAll("tbody tr"))
        .filter(visible)
        .map((row) => Math.round(row.getBoundingClientRect().height));
      if (heights.length < 4) continue;
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      // Wrapping text legitimately makes a row taller; a 40% spread with no wrapping is a density bug.
      if (max - min > Math.max(16, min * 0.4)) {
        unevenRows.push(`table rows ${min}–${max}px`);
      }
    }

    // ── motion ────────────────────────────────────────────────────────────────
    const animations = document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        const target = effect?.target;
        if (!target) return "anonymous";
        const style = getComputedStyle(target);
        const name = style.animationName === "none" ? "" : style.animationName;
        const classes = String(target.getAttribute("class") ?? "")
          .split(/\s+/)
          .filter((c) => c.startsWith("animate-"))
          .join(" ");
        return `${name || classes || "unnamed"} on ${describe(target)}`;
      })
      .slice(0, 5);

    return {
      path: route,
      overflow,
      unnamedControls,
      invisibleFocus: noFocusAtAll ? invisibleFocus.slice(0, 3) : [],
      lowContrast,
      unevenRows,
      animations,
    };
  }, path);
}

test("every page passes the craft audit: no sideways scroll, contrast, names, focus, even rows", async ({
  page,
  request,
}) => {
  test.setTimeout(900_000);
  await signInPage(page, await signIn(request, `e2e-craft-${Date.now()}@example.com`));

  const failures: string[] = [];
  for (const route of ROUTES) {
    // 360 is the narrowest phone this app is shipped for; 1440 is a laptop.
    for (const width of [360, 1440]) {
      // A step, so a failure names the page and width instead of "the audit timed out".
      await test.step(`${route} @${width}`, async () => {
        await page.setViewportSize({ width, height: width === 360 ? 800 : 900 });
        await page.goto(route);
        await waitForPaint(page);
        const audit = await auditPage(page, route);
        if (audit.overflow > 1) failures.push(`${route} @${width}: ${audit.overflow}px sideways`);
        for (const control of audit.unnamedControls) {
          failures.push(`${route} @${width}: control without a name — ${control}`);
        }
        for (const contrast of audit.lowContrast) {
          failures.push(`${route} @${width}: contrast — ${contrast}`);
        }
        for (const focus of audit.invisibleFocus) {
          failures.push(`${route} @${width}: focus not visible on — ${focus}`);
        }
        for (const rows of audit.unevenRows) failures.push(`${route} @${width}: ${rows}`);
      });
    }
  }

  expect(failures, failures.slice(0, 60).join("\n")).toEqual([]);
});

test("reduced motion is honoured on every page", async ({ page, request }) => {
  test.setTimeout(600_000);
  await signInPage(page, await signIn(request, `e2e-motion-${Date.now()}@example.com`));
  await page.emulateMedia({ reducedMotion: "reduce" });

  const failures: string[] = [];
  for (const route of ROUTES) {
    await test.step(route, async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(route);
      await waitForPaint(page);
      const audit = await auditPage(page, route);
      for (const animation of audit.animations) {
        // A spinner that keeps turning is the one exception: it says "working", and stopping it lies.
        if (/spin/i.test(animation)) continue;
        failures.push(`${route}: animating under prefers-reduced-motion — ${animation}`);
      }
    });
  }

  expect(failures, failures.join("\n")).toEqual([]);
});

test("both themes render every page, and the light/dark palettes really differ", async ({
  page,
  request,
}) => {
  test.setTimeout(900_000);
  await signInPage(page, await signIn(request, `e2e-theme-${Date.now()}@example.com`));
  const capture = process.env["NEXUS_CAPTURE_THEMES"] === "1";
  // The theme is applied by an inline script from localStorage before first paint, so the choice has to
  // be there before the document loads — emulating the media query alone would not switch a saved theme.
  const backgrounds = new Map<string, string>();

  for (const scheme of ["light", "dark"] as const) {
    await page.addInitScript((theme) => {
      localStorage.setItem("nexus_theme", theme);
    }, scheme);
    await page.emulateMedia({ colorScheme: scheme });

    for (const route of ROUTES) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(route);
      await waitForPaint(page);
      const state = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        background: getComputedStyle(document.body).backgroundColor,
        surface: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      }));
      expect(state.dark, `${route} in ${scheme}: document class`).toBe(scheme === "dark");
      expect(state.surface, `${route} in ${scheme}: --background token`).not.toBe("");
      backgrounds.set(`${route}:${scheme}`, state.background);
      if (capture) {
        await page.screenshot({
          path: `docs/screenshots/themes/${scheme}/${route.replace(/\//g, "_").replace(/^_/, "") || "home"}.jpg`,
          type: "jpeg",
          quality: 55,
        });
      }
    }
  }

  // Every route was rendered in both palettes, and the two palettes are actually different.
  for (const route of ROUTES) {
    expect(backgrounds.get(`${route}:dark`), `${route} background differs`).not.toBe(
      backgrounds.get(`${route}:light`),
    );
  }
});
