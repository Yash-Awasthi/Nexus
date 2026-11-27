<!-- verified: 8065a84 2026-11-25 -->

# Interface craft

What the app does when it is not at its best — loading, empty, failing, offline — and what every page is
measured against. The measurements are tests, not a review: `apps/ui/tests/e2e/states.spec.ts`,
`craft.spec.ts` and `motion-budget.spec.ts` walk the navigation and fail on the specific page.

## The four states, one module

`apps/ui/app/components/states.tsx` is the only place a page's non-success states are written:

| State   | Component                                            | What it guarantees                                                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Loading | `PageLoading`                                        | A skeleton of the page's shape, `role="status"`, announced politely, `data-state="loading"` |
| Empty   | `EmptyState` (from `components/page`), `InlineEmpty` | Says there is nothing _and_ what to do next, `data-state="empty"`                           |
| Error   | `PageError`                                          | The reason, `role="alert"`, and a retry button when one exists, `data-state="error"`        |
| Offline | `OfflineBar`                                         | One bar for the whole app, mounted in the shell, `data-state="offline"`                     |

Two more pieces exist because a page cannot always know it failed:

- `ServerTroubleBar` — the global fetch interceptor reports every 5xx and dead socket to
  `lib/api-health.ts`; the shell shows one bar for the whole outage and clears it on the next successful
  response. Before this, a page that fell back to an empty list or to default preferences looked exactly
  like a page with nothing in it.
- The offline bar polls `navigator.onLine` every three seconds in addition to listening for the
  `online`/`offline` events, because Chrome's own network emulation flips `navigator.onLine` without
  dispatching an event and a laptop waking from sleep often misses both.

### What the states test found

Walking all 29 navigation routes with the API stubbed to return nothing, then to fail, then with the
network switched off turned up pages that were silently wrong rather than merely ugly. Each is fixed:

- **Preferences** fell back to `DEFAULTS` on a failed fetch, so a person saw their settings switched off
  and was invited to "fix" settings that had never been lost. It now says what happened and offers a retry.
- **Workflows** fell back to the copies in `localStorage` without saying so; the page now states which
  copy is on screen.
- **Knowledge bases** treated a failed list as "no knowledge bases yet", which invited creating a
  duplicate of a base that already existed.
- **The sandbox, terminals, gateway, MCP servers, costs, archetypes and settings** answered a failed load
  with a bare red sentence that a screen reader never announced and that offered no way forward. They use
  `PageError` now.
- **Chat's** empty deliberation list is an announced empty state rather than plain grey text.

## Density

The craft audit measures, at 360 px and 1440 px on every page: document overflow, and elements past the
right edge that have no scrolling ancestor. Both must be zero. Tables are allowed to be wider than a
phone _inside_ an `overflow-x-auto` container — that is a scroll, not a broken layout — so the audit
distinguishes the two instead of failing on coordinates.

## Accessibility

Measured on every page, both widths:

- **Names.** Every `button`, link and `role="switch"` must resolve an accessible name from
  `aria-label`, `aria-labelledby`, its text, or a `<label for>`. Icon-only controls found without one
  (the admin configuration table's edit/save/cancel) got explicit labels.
- **Focus.** Every focusable control is focused and its computed outline/shadow compared to the unfocused
  state; a page where _no_ control changes appearance fails.
- **Contrast.** Text is measured against its composited background, following the ancestor chain and
  skipping gradients and photographs, with the WCAG floors of 4.5:1 (normal) and 3:1 (large). Computed
  colours here are `oklch`/`oklab`, so the audit converts OKLab to sRGB with the CSS Color 4 matrices —
  reading the numbers with a regex would have invented failures.
- **Motion.** With `prefers-reduced-motion: reduce`, no animation may run except a spinner. The app-wide
  media query collapses entrance animations, skeleton pulses and transitions to a single instant frame
  and keeps `.animate-spin` turning, because a frozen spinner turns "wait" into "broken".

Fixing the contrast findings changed two tokens in `app.css`: `--success` L 0.56 → 0.52 (4.01:1 →
5.09:1 on white) and `--warning` L 0.7 → 0.55 (2.75:1 → 4.99:1). Inactive tab labels were
`text-foreground/60` (4.46:1) and are now `text-muted-foreground`.

## Motion budget

The two WebGL scenes — the landing council and the knowledge graph — share one policy in
`apps/ui/app/lib/adaptive-quality.ts`: measure 90 frames, and if the average is under 45 fps step down
once — pixel ratio 2 → 1.5 → 1, then stop the idle rotation entirely. It never steps back up, because
oscillating between settings is worse than staying plain, and the last step is a static scene that still
answers a drag rather than a spinning one at 12 fps. `tests/adaptive-quality.test.ts` covers the policy;
`tests/e2e/motion-budget.spec.ts` measures the real scenes and is printed as `motion budget — …`.

Measured in this repository's headless Chromium (a software rasteriser, no GPU): landing **35.5 fps**,
graph view **60.5 fps** with 40 entities. A machine with a GPU is the point of comparison for those
numbers, not this one; what the test enforces is that the scenes stay responsive or stop spending.

## Themes

Light and dark come from the same token block in `app.css`; the choice is applied before first paint by
an inline script reading `localStorage`. `craft.spec.ts` renders all 29 pages in both themes, asserts the
document class and the resolved `--background`, and asserts the two palettes differ on every page.
Setting `NEXUS_CAPTURE_THEMES=1` writes 58 JPEGs to `docs/screenshots/themes/{light,dark}/` for review;
like the baseline screenshots they are opt-in, because a set that rewrites itself cannot show a
regression.
