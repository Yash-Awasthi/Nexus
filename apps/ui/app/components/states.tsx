// SPDX-License-Identifier: Apache-2.0
/**
 * The four states every page can be in, in one place.
 *
 * A page is not only its success case. Before this module each route invented its own "Loading…"
 * paragraph and its own red error line, which meant four different wordings, three of them silent to a
 * screen reader, and none of them actionable — the user could not retry without reloading the page.
 * These four components are the answer, and they carry `data-state` so the states test can walk every
 * route with the API stubbed to empty, failing and offline and prove the page says something.
 *
 * `EmptyState` lives in `~/components/page` with the other page furniture; the components here are the loading,
 * error and empty-line states that a route reaches for alongside it.
 */
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { apiTroubleMessage, apiTroubleSnapshot, subscribeApiTrouble } from "~/lib/api-health";
import { cn } from "~/lib/utils";

/**
 * A skeleton of the page that is coming, not a spinner over nothing.
 *
 * Announced politely rather than assertively: a loading state is not an error and must not interrupt
 * whatever a screen reader is already saying.
 */
export function PageLoading({
  label = "Loading…",
  rows = 3,
  className,
}: {
  label?: string;
  /** How many text rows the real page has room for; rows of skeleton read as the page's shape. */
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-3 p-4 sm:p-6", className)}
      data-state="loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <div className="space-y-2 pt-2">
        {Array.from({ length: Math.max(1, rows) }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * A page that could not load, with the reason and a way to try again.
 *
 * `role="alert"` because this replaces the page a person asked for; the retry handler is optional only
 * for pages whose data arrives once and cannot be refetched without a reload.
 */
export function PageError({
  title = "Could not load this page",
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-4 my-6 flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-4 sm:mx-6",
        className,
      )}
      data-state="error"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{title}</p>
          {message && <p className="text-sm break-words text-muted-foreground">{message}</p>}
        </div>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden className="size-4" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  // Not every browser fires `online`/`offline` when the connection changes underneath it — Chrome's own
  // network emulation flips `navigator.onLine` without an event, and a laptop waking from sleep often
  // misses both. A slow poll costs nothing and is the only thing that catches those cases.
  const poll = window.setInterval(onChange, 3000);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
    window.clearInterval(poll);
  };
}

/**
 * Whether the browser believes it has a network.
 *
 * `useSyncExternalStore` rather than `useEffect` + `useState`: the server has no `navigator`, and a
 * hydrated first paint must not flash "offline" on a page that is online. `true` during SSR is the
 * conservative answer — the banner appears only once the browser says otherwise.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    () => true,
  );
}

/**
 * The offline bar: one line, above the page, that says work is safe.
 *
 * It is a banner and not a modal on purpose. Losing the network while reading is not an emergency, and
 * a dialog would steal the keyboard from whatever the person was typing. The queue itself is the host's
 * job (`~/lib/offline-notice`); this only reports the connection.
 */
export function OfflineBar({ queued = 0 }: { queued?: number }) {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      className="flex items-center gap-2 border-b border-warning/40 bg-warning-surface px-4 py-2 text-xs text-foreground"
      data-state="offline"
      role="status"
      aria-live="polite"
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <span>
        You are offline. Pages you already opened keep working
        {queued > 0
          ? `, and ${queued === 1 ? "1 prompt is" : `${queued} prompts are`} waiting to send`
          : ", and anything you save will send when the connection returns"}
        .
      </span>
    </div>
  );
}

/**
 * The server-trouble bar: what a page cannot say for itself.
 *
 * A page that fetched once and fell back to an empty list has no way to know it was lied to; the fetch
 * interceptor does, and reports it here. Cleared by the next successful response, so it retires itself.
 */
export function ServerTroubleBar() {
  const trouble = useSyncExternalStore(subscribeApiTrouble, apiTroubleSnapshot, () => null);
  if (!trouble) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      data-state="error"
      role="alert"
    >
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{apiTroubleMessage(trouble)}</span>
      <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

/** A quiet line for "the request worked and there is nothing here", outside a bordered box. */
export function InlineEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground" data-state="empty">
      {children}
    </p>
  );
}
