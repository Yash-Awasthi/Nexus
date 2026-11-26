<!-- verified: c6e5d6c 2026-11-24 -->
# Keyboard shortcuts

The command palette is the entry point: it opens every page, the handful of actions worth a
shortcut, and the sessions, deliberations, workflows and knowledge bases you own — from one
box. Everything else on this page works without it.

## The palette

| Key | Does |
| --- | --- |
| `⌘K` / `Ctrl K` | Open the palette from anywhere, including inside another input. Press it again to close. |
| `↑` `↓` | Move the highlight. The list does not wrap past the ends — it wraps, but never scrolls you out of view. |
| `↵` | Run the highlighted entry: open the page, run the action, open the item. |
| `Tab` | Complete the box to the highlighted label, so you can keep typing to narrow further. |
| `Esc` | Close without running anything. |

What it searches, in the order it ranks:

1. **Your work** — sessions, deliberations, workflows, knowledge bases, documents and graph
   nodes, from `GET /api/v1/search`. Results appear after two characters and one short pause,
   so typing does not send a request per keystroke.
2. **Pages** — the same list the sidebar renders, from `apps/ui/app/lib/nav.ts`. A page you can
   click is a page you can find; the two registries are one registry.
3. **Actions** — new deliberation, switch theme, open search, open the sandbox (local installs
   only), sign out.

Ranking is a scored substring — exact label, then prefix, then substring, then a keyword the
page added for search — not a fuzzy match. At this size, fuzzy matching finds surprises
("run" opening Sandbox) more often than it finds what you meant.

## Pages

Every page has a `keywords` list in `apps/ui/app/lib/nav.ts`. When a page is hard to find, add
the words people type to that list rather than renaming the page.

## Everywhere

| Key | Does |
| --- | --- |
| `Tab` / `Shift Tab` | Move focus. Nothing in the app traps focus outside a dialog. |
| `Esc` | Close the open dialog, menu or palette. |
| `↵` | Submit the focused form. |

## Accessibility contract

- Every action reachable by mouse is reachable by keyboard, and the palette never becomes the
  *only* way to reach something.
- Focus is visible on every interactive element (a 2 px ring, not a colour shift alone).
- The palette is a real dialog: `role="dialog"`, a labelled input, focus moved in on open and
  returned to the page on close, and the list is announced as it filters.
- `prefers-reduced-motion` removes the palette's opening animation and the landing scene's
  camera movement.

If you add a shortcut, add it here and to the palette's action table in the same change —
a shortcut documented in one place and implemented in another is a shortcut that will drift.
