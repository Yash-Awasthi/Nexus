// SPDX-License-Identifier: Apache-2.0
/**
 * First-visit coach marks: one hint per page, said once, dismissible, remembered per user and
 * per page.
 *
 * Three rules, and the storage design follows from them:
 *
 *  - **Once.** A hint that comes back is a nag. The record is written on dismissal, and a page
 *    whose hint was dismissed never shows it again.
 *  - **Per user.** Two people share a browser far more often than a codebase admits. The key is
 *    `nexus.coach.<userId>.<page>`, so signing out and in as someone else does not inherit their
 *    dismissals — and an anonymous browser gets its own bucket rather than nobody's.
 *  - **Per page, not per app.** A user who learned the knowledge page has not learned workflows.
 *
 * The hint text lives here, next to the key, so a hint cannot exist without a page to attach it
 * to — and `apps/ui/tests/coach-marks.test.ts` fails if a hint names a page that is not in the
 * navigation registry.
 */

/** Prefix for every dismissal key. Changing it re-shows every hint — a migration, of a sort. */
export const COACH_PREFIX = "nexus.coach";

export interface CoachMark {
  /** Route the hint belongs to, exactly as `app/lib/nav.ts` spells it. */
  page: string;
  title: string;
  body: string;
  /** The single next action, phrased as a verb. Shown on the dismiss button when set. */
  action?: string;
}

/**
 * The hints, one per page that needs one. Pages absent from this list have no coach mark —
 * which is most of them, and `/chat` on purpose: its empty state already explains the council
 * and offers starter questions, so a hint above it would say the same thing twice, worse.
 */
export const COACH_MARKS: CoachMark[] = [
  {
    page: "/knowledge",
    title: "Your knowledge bases live here",
    body: "Upload documents once and every council answer can cite them. Start with the file you would hand a new colleague.",
    action: "Upload a document",
  },
  {
    page: "/workflows",
    title: "Workflows are steps, not scripts",
    body: "Each node is one step: a model call, a condition or a pass-through. Press Run to see every step's output in the trace.",
    action: "Create a workflow",
  },
  {
    page: "/templates",
    title: "Start from something that already works",
    body: "Every template is built into this server and readable before you create it. Make a copy, then edit it — the original stays untouched.",
  },
  {
    page: "/knowledge-graph",
    title: "The graph is assembled, not stored",
    body: "Sync a knowledge base to extract entities and the relationships between them. Nothing is sent anywhere until you press Sync.",
    action: "Sync a base",
  },
  {
    page: "/costs",
    title: "Cost is per call, not per account",
    body: "Every row is one request with its model, tokens and price. The total at the top is the sum of the rows you can see.",
  },
  {
    page: "/sandbox",
    title: "Code runs in its own box",
    body: "The sandbox has no network unless an admin allowed it, and no access to your files. Results are readable only by you.",
    action: "Run something",
  },
];

/** The key a dismissal is stored under. */
export function coachKey(page: string, userId?: string | null): string {
  return `${COACH_PREFIX}.${userId ?? "anonymous"}.${page}`;
}

/** The hint for a page, or undefined when that page has none. */
export function coachMarkFor(page: string): CoachMark | undefined {
  return COACH_MARKS.find((mark) => mark.page === page);
}

/** A storage-like object: `localStorage` in the app, a stub in the test. */
export interface CoachStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether this user has dismissed this page's hint. A store that throws counts as dismissed. */
export function isDismissed(
  page: string,
  userId: string | null | undefined,
  store: CoachStore,
): boolean {
  try {
    return store.getItem(coachKey(page, userId)) === "1";
  } catch {
    // Private mode, a full quota, a blocked storage: never show a hint we cannot remember.
    return true;
  }
}

/** Remember the dismissal. Failure is silent, for the same reason. */
export function dismissCoachMark(
  page: string,
  userId: string | null | undefined,
  store: CoachStore,
): void {
  try {
    store.setItem(coachKey(page, userId), "1");
  } catch {
    // Nothing to do: the hint simply appears again next visit.
  }
}

/** The hint this user should see on this page, or undefined. */
export function pendingCoachMark(
  page: string,
  userId: string | null | undefined,
  store: CoachStore,
): CoachMark | undefined {
  const mark = coachMarkFor(page);
  if (!mark) return undefined;
  return isDismissed(page, userId, store) ? undefined : mark;
}
