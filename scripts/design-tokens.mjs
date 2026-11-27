// SPDX-License-Identifier: Apache-2.0
/**
 * The token rule: colour and size come from `app/app.css`, not from a literal in a component.
 *
 * Why a build gate rather than a code review note: a literal `#3b82f6` looks right in the theme it
 * was written in and wrong in every other one, and nobody notices until a screenshot diff. The rule
 * is mechanical, so it should be checked mechanically.
 *
 * What it refuses:
 *
 * - **A colour literal** — `#rrggbb`, `#rgb`, `rgb(...)`, `hsl(...)`, `oklch(...)` — anywhere in
 *   `apps/ui/app/**` except the token file itself (`app.css`).
 * - **An arbitrary Tailwind value** — `p-[13px]`, `text-[11px]`, `bg-[#fff]` — a literal with the
 *   token system bypassed. `bg-[var(--card)]` is allowed: that *is* the token system.
 *
 * What it allows, and only with the reason written down: a file whose header carries
 * `design-tokens-allow-file: <reason>`. The run prints that list, so an exemption shows up in the
 * log instead of hiding in a file.
 *
 * Inline `fontSize: 11` still exists in a couple of legacy panels. That is counted and reported, not
 * refused: the fix is a class rewrite those panels have not had, and a rule that fails on it today
 * would be switched off within a week.
 */
import fs from "node:fs";
import path from "node:path";

export const APP_DIR = "apps/ui/app";
/** The token file is the source of truth: literals are its job. */
export const TOKEN_FILE = "apps/ui/app/app.css";
const ALLOW_MARKER = /design-tokens-allow-file:\s*(\S.*)$/m;

const COLOR_PATTERNS = [
  { name: "hex colour", pattern: /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\([^)]*\)/g },
  { name: "hsl()/hsla()", pattern: /\bhsla?\([^)]*\)/g },
  { name: "oklch()/oklab()", pattern: /\bokl(ch|ab)\([^)]*\)/g },
];

/** `p-[13px]`, `text-[11px]`, `bg-[#fff]`. `data-[state=open]:` is a variant, not a size. */
const ARBITRARY_VALUE = /\b[a-z-]+-\[[^\]]*\]/g;

/**
 * A Tailwind palette colour (`text-amber-500`). It is a literal with a nicer name: it ignores the
 * theme, so it stays the same yellow in dark mode. The app's own `--success`/`--warning` exist for
 * exactly these cases.
 */
const PALETTE_COLOR =
  /\b(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|shadow|caret|accent|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/g;

/** Every file the rule reads. */
export function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "build") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(root, APP_DIR));
  return out.sort();
}

/** The exemption a file declares in its first lines, if any. */
export function fileExemption(text) {
  const head = text.split("\n").slice(0, 12).join("\n");
  const match = ALLOW_MARKER.exec(head);
  return match ? match[1].trim() : null;
}

/**
 * Whether a hit is really a colour. `#fff` inside `url(#clip)` is an id, not a colour, and the same
 * goes for an `href="#abc"` anchor and an `aria-labelledby="#x"`.
 */
function isReference(line, column, kind) {
  if (kind !== "hex colour") return false;
  const before = line.slice(0, column);
  return /url\($/.test(before) || /(?:id|href|aria-labelledby)=["'][^"']*$/.test(before);
}

export function scanSource(file, text) {
  const violations = [];
  const relative = file.split(path.sep).join("/");
  text.split("\n").forEach((line, index) => {
    // A comment that explains the rule is not a violation.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    for (const { name, pattern } of COLOR_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const column = match.index ?? 0;
        if (isReference(line, column, name)) continue;
        violations.push({
          file: relative,
          line: index + 1,
          column: column + 1,
          kind: name,
          text: match[0],
        });
      }
    }

    ARBITRARY_VALUE.lastIndex = 0;
    for (const match of line.matchAll(ARBITRARY_VALUE)) {
      const value = match[0];
      const bracket = value.slice(value.indexOf("[") + 1, -1);
      // `bg-[var(--card)]` is the token system; `data-[state=open]:` is a variant selector, not a
      // size; a variant with no `=` (`group-data-[collapsible=icon]`) is the same thing.
      if (bracket.includes("var(--")) continue;
      if (bracket.includes("=")) continue;
      if (/^(group-|peer-|has-|data-|aria-)/.test(value)) continue;
      violations.push({
        file: relative,
        line: index + 1,
        column: (match.index ?? 0) + 1,
        kind: "arbitrary value",
        text: value,
      });
    }

    PALETTE_COLOR.lastIndex = 0;
    for (const match of line.matchAll(PALETTE_COLOR))
      violations.push({
        file: relative,
        line: index + 1,
        column: (match.index ?? 0) + 1,
        kind: "palette colour",
        text: match[0],
      });
  });
  return violations;
}

/** Count inline size values in `style={{}}`, which are the known gap. */
export function countInlinePx(text) {
  const matches =
    text.match(/\b(fontSize|padding|margin|gap|width|height|borderRadius):\s*[^,\n]*/g) ?? [];
  return matches.filter((m) => /\d/.test(m) && !m.includes("var(--")).length;
}

export const BUDGET_FILE = ".github/design-tokens-budget.json";

/** The ratchet: what the repo is allowed to contain today. Missing file = zero tolerance. */
export function readBudget(root) {
  try {
    const raw = fs.readFileSync(path.join(root, BUDGET_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return {
      arbitraryValues: Number(parsed.arbitraryValues ?? 0),
      inlinePx: Number(parsed.inlinePx ?? 0),
    };
  } catch {
    return { arbitraryValues: 0, inlinePx: 0 };
  }
}

export function scan(root) {
  const violations = [];
  const exemptions = [];
  let inlinePx = 0;

  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (relative === TOKEN_FILE) continue;
    const text = fs.readFileSync(file, "utf8");
    const reason = fileExemption(text);
    if (reason) {
      exemptions.push({ file: relative, reason });
      continue;
    }
    violations.push(...scanSource(file, text));
    if (relative.endsWith(".tsx")) inlinePx += countInlinePx(text);
  }

  return { violations, exemptions, inlinePx };
}

/** Compare a scan against the budget; a colour literal is never inside it. */
export function verdict(result, budget) {
  const colours = result.violations.filter((v) => v.kind !== "arbitrary value"); // hex, rgb, hsl, oklch, palette
  const arbitrary = result.violations.length - colours.length;
  const over = [];
  if (arbitrary > budget.arbitraryValues)
    over.push(`arbitrary values: ${arbitrary} > budget ${budget.arbitraryValues}`);
  if (result.inlinePx > budget.inlinePx)
    over.push(`inline px: ${result.inlinePx} > budget ${budget.inlinePx}`);
  return {
    ok: colours.length === 0 && over.length === 0,
    colours: colours.length,
    arbitrary,
    over,
  };
}

export function format(result, budget) {
  const lines = [];
  const judged = verdict(result, budget ?? { arbitraryValues: 0, inlinePx: 0 });
  for (const v of result.violations) {
    if (v.kind === "arbitrary value" && judged.ok) continue;
    lines.push(`${v.file}:${v.line}:${v.column}  ${v.kind}  ${v.text}`);
  }
  if (result.exemptions.length)
    lines.push(
      "",
      `${result.exemptions.length} file(s) exempt by declaration:`,
      ...result.exemptions.map((e) => `  ${e.file} — ${e.reason}`),
    );
  lines.push(
    "",
    `colour literals: ${judged.colours} (budget 0)`,
    `arbitrary values: ${judged.arbitrary} (budget ${budget?.arbitraryValues ?? 0})`,
    `inline px: ${result.inlinePx} (budget ${budget?.inlinePx ?? 0})`,
  );
  if (judged.ok) lines.push("TOKEN CHECK PASS");
  else if (judged.colours > 0)
    lines.push(
      `TOKEN CHECK FAIL — ${judged.colours} colour literal(s); every colour belongs in apps/ui/app/app.css`,
    );
  else lines.push(`TOKEN CHECK FAIL — ${judged.over.join("; ")}`);
  return `${lines.join("\n")}\n`;
}

// CLI: `node scripts/design-tokens.mjs [root]`
const invokedDirectly = process.argv[1]?.endsWith("design-tokens.mjs") ?? false;
if (invokedDirectly) {
  const root = path.resolve(process.argv[2] ?? ".");
  const result = scan(root);
  const budget = readBudget(root);
  process.stdout.write(format(result, budget));
  process.exitCode = verdict(result, budget).ok ? 0 : 1;
}
