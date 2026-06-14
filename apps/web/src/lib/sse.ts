// SPDX-License-Identifier: Apache-2.0
/**
 * useEventSource — React hook for Server-Sent Events.
 *
 * Connects to the given SSE URL and calls `onEvent` for each message.
 * Automatically reconnects on error (browser EventSource handles this).
 * Cleans up the connection on component unmount or URL change.
 *
 * Note: EventSource does not support custom request headers in the browser.
 * Auth is handled by passing the API key as a query param when VITE_API_KEY
 * is set. In dev mode the API skips auth when NEXUS_API_KEY is unset.
 *
 * Usage:
 *   const { connected } = useEventSource<TaskUpdatePayload>(
 *     "/api/v1/sse/tasks",
 *     "task.update",
 *     (payload) => setTasks(prev => ...),
 *   );
 */

import { useEffect, useRef, useState } from "react";

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? "";

/** Build full SSE URL, optionally appending the API key as a query param */
export function sseUrl(path: string): string {
  const url = `${BASE}${path}`;
  return KEY ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}` : url;
}

export type SseStatus = "connecting" | "connected" | "error" | "closed";

export interface UseEventSourceResult {
  status: SseStatus;
  error: string | null;
  /** Manually close and stop reconnecting */
  close: () => void;
}

/**
 * Subscribe to an SSE endpoint and call `onEvent` for each matching event.
 *
 * @param path      API path, e.g. "/api/v1/sse/tasks"
 * @param eventType SSE event name to listen for (e.g. "task.update").
 *                  Pass null to listen to all unnamed message events.
 * @param onEvent   Called with the parsed JSON payload on each event
 * @param enabled   Set false to disable the connection (default: true)
 */
export function useEventSource<T>(
  path: string,
  eventType: string | null,
  onEvent: (payload: T) => void,
  enabled = true,
): UseEventSourceResult {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    closedRef.current = false;
    setStatus("connecting");
    setError(null);

    const url = sseUrl(path);
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (!closedRef.current) setStatus("connected");
    };

    const handleMessage = (e: MessageEvent<string>): void => {
      if (closedRef.current) return;
      try {
        const payload = JSON.parse(e.data) as T;
        onEvent(payload);
      } catch {
        // non-JSON frame (e.g. keepalive comment) — ignore
      }
    };

    if (eventType) {
      es.addEventListener(eventType, handleMessage as EventListener);
    } else {
      es.onmessage = handleMessage;
    }

    es.onerror = () => {
      if (!closedRef.current) {
        setStatus("error");
        setError("SSE connection lost — browser will retry");
      }
    };

    return () => {
      closedRef.current = true;
      es.close();
      esRef.current = null;
      setStatus("closed");
    };
    // onEvent intentionally omitted from deps — callers should memoize if needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, eventType, enabled]);

  const close = (): void => {
    closedRef.current = true;
    esRef.current?.close();
    esRef.current = null;
    setStatus("closed");
  };

  return { status, error, close };
}
