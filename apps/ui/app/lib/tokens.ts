// SPDX-License-Identifier: Apache-2.0
/**
 * Design tokens, as the code sees them.
 *
 * `app/app.css` is the single source: `:root` and `.dark` define every colour, radius and chart
 * hue once. This module does not restate them — it names them, so a component that needs a colour
 * inside an inline style or an SVG attribute asks for the token instead of writing a literal.
 *
 * Why the indirection at all: a literal `#3b82f6` in a component is invisible to the theme, so it
 * stays dark-theme blue when the page is light. A `var(--chart-2)` follows the theme for free, and
 * `scripts/design-tokens.mjs` can fail a build that writes a literal instead.
 */

/** A CSS custom property reference, e.g. `var(--chart-2)`. */
export function token(name: string): string {
  return `var(--${name})`;
}

/** The five chart hues the palette defines, in order. Useful for series and pie slices. */
export const CHART_SERIES = [
  token("chart-1"),
  token("chart-2"),
  token("chart-3"),
  token("chart-4"),
  token("chart-5"),
] as const;

/**
 * Categorical identity colours — one per entity type, provider, or speaker.
 *
 * These are deliberately not derived from the chart hues: a category colour has to stay the same
 * when the data changes, and two entity types in a graph must never share a hue.
 */
export const CATEGORY_COLORS = [
  token("cat-1"),
  token("cat-2"),
  token("cat-3"),
  token("cat-4"),
  token("cat-5"),
  token("cat-6"),
  token("cat-7"),
  token("cat-8"),
] as const;
