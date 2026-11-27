<!-- verified: 8065a84 2026-11-25 -->

# Design tokens

Every colour and every size in `apps/ui` comes from one file: `apps/ui/app/app.css`. A component
names a token; it never writes `#3b82f6`, `rgb(...)` or `text-[10px]`.

This is enforced, not suggested. `pnpm tokens:check` (`scripts/design-tokens.mjs`) fails a build on a
colour literal, and is wired into the `lint` job so a pull request cannot land one.

## Why a gate

A literal looks right in the theme it was written in. `#1a1a1a` is a sensible panel background in
dark mode and an invisible one in light mode, and nobody notices until someone opens the light theme
— or until a screenshot diff on a route nobody visits. Code review does not catch this reliably
because the diff looks fine. A mechanical rule catches it every time.

There is a second reason: changing a colour should be one edit. When the accent lived in fourteen
` #3b82f6` strings, "make the accent warmer" was a search-and-replace with no guarantee of coverage.

## What is where

| Layer                  | Lives in                      | Named like                                                                                                                                  |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme surfaces         | `app.css` `:root` and `.dark` | `--background`, `--card`, `--popover`, `--border`, `--muted-foreground`, `--primary`, `--accent`, `--destructive`, `--success`, `--warning` |
| Tinted banner surfaces | `app.css`                     | `--destructive-surface`, `--success-surface`                                                                                                |
| Chart series           | `app.css`                     | `--chart-1` … `--chart-5`                                                                                                                   |
| Category colours       | `app.css`                     | `--cat-1` … `--cat-8`                                                                                                                       |
| Type scale             | `app.css` `@theme inline`     | `--text-4xs` (9px), `--text-3xs` (10px), `--text-2xs` (11px)                                                                                |
| Tailwind utilities     | `app.css` `@theme inline`     | `bg-background`, `text-muted-foreground`, `text-3xs`, …                                                                                     |

`--cat-*` are deliberately the same hue in both themes, with only the lightness tuned. A category
colour that changes identity when the theme flips turns a chart legend into a lie.

In TypeScript, `apps/ui/app/lib/tokens.ts` is the readable way to reach the same names from an inline
style or a chart library:

```tsx
import { token, CHART_SERIES, categoryColor, SURFACE, RADIUS } from "~/lib/tokens";

<Line stroke={CHART_SERIES[1]} />
<div style={{ background: token("card"), borderRadius: RADIUS.lg, borderColor: SURFACE.border }} />
<ProviderGlyph provider="openai" /> {/* categoryColor(hash) inside */}
```

`token("card")` returns the string `var(--card)` — it is a name, not a copy of the value, so the
element follows a theme change without re-rendering.

## The rule, exactly

`scripts/design-tokens.mjs` reads every `.ts`, `.tsx` and `.css` file under `apps/ui/app` and refuses:

- a hex colour (`#rgb`, `#rrggbb`, `#rrggbbaa`), except an SVG reference like `url(#clip)`;
- `rgb()` / `rgba()` / `hsl()` / `hsla()` / `oklch()` / `oklab()`;
- a Tailwind palette colour (`text-amber-500`, `border-red-600`) — a literal with a nicer name,
  which stays the same yellow in dark mode;
- an arbitrary Tailwind value (`p-[13px]`, `text-[11px]`, `bg-[#fff]`), except `bg-[var(--card)]`,
  which is the token system, and a variant selector (`data-[state=open]`, `group-data-[collapsible=icon]`).

`apps/ui/app/app.css` is exempt: writing the values there is its job.

### Two ratchets, and why they are not zero

Inline `style={{ fontSize: 11 }}` in a couple of legacy panels, and 75 arbitrary Tailwind sizes in
component-specific layouts (`h-[200px]`, `tracking-[0.2em]`). Those are real literals and they are
also not a one-line fix — the panel needs a class rewrite it has not had. A rule that failed on them
today would be switched off within a week, so they are **budgeted** instead:

```json
{ "arbitraryValues": 75, "inlinePx": 66 }
```

`.github/design-tokens-budget.json` holds the number. The check fails when the count **grows**, so new
code cannot add one, and the number can only fall as files are migrated. Lower it in the same commit
that removes values. Never raise it without explaining why in the commit message.

Colour literals have no budget: that count is zero.

### Declared exemptions

A file that genuinely cannot use a token says so in its header:

```ts
// design-tokens-allow-file: brand mark — the Google logo is drawn in Google's own colours
```

The run prints every exemption with its reason, so an exemption is visible in the CI log rather than
hidden in a file. Six exist today:

| File                                  | Why                                                                  |
| ------------------------------------- | -------------------------------------------------------------------- |
| `components/auth-shell.tsx`           | Google's logo, in Google's colours                                   |
| `components/landing/council-scene.ts` | painted into a canvas with per-frame alpha ramps                     |
| `components/landing/motion.tsx`       | a transparent-to-white mask, where alpha is geometry                 |
| `routes/landing.tsx`                  | one hero gradient string built from accent alpha steps               |
| `lib/printable.ts`                    | produces a standalone HTML file opened outside the app               |
| `root.tsx`                            | `<meta name="theme-color">`, read by browser chrome before CSS loads |

## Adding a colour

1. Add it to `:root` (light) and `.dark` in `apps/ui/app/app.css`, as `oklch(...)`.
2. If it should be a Tailwind utility, map it in `@theme inline` as `--color-<name>`.
3. Use `bg-<name>` / `text-<name>`, or `token("<name>")` from TS.
4. `pnpm tokens:check` — it must pass without touching the budget.

## Adding a size

If Tailwind's own scale does not have the step you need, add it to `@theme inline` rather than
writing an arbitrary value. The small labels are already there: use `text-3xs` for 10px and
`text-2xs` for 11px.

## Verifying

```bash
pnpm tokens:check                                # the gate, prints both ratchets and the exemptions
node --test scripts/design-tokens.test.mjs       # 12 tests, including one against this repo
```

The repository test asserts the real tree: zero colour literals, inside the written budget, and the
declared type scale present. That way a change to the rule cannot quietly weaken the gate.
