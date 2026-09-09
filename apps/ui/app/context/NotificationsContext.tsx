// SPDX-License-Identifier: Apache-2.0
/**
 * NotificationsContext — single client-side owner of the notification tray.
 *
 * Both the sidebar bell and the dashboard Activity feed render from this one
 * state source, so a read/dismiss anywhere updates the badge everywhere at
 * once (previously the bell polled one endpoint and the dashboard carried its
 * own copy inside the /api/dashboard payload — they could disagree for up to
 * a minute).
 *
 * Delivery: the server is the source of truth (GET /api/notifications, /count,
 * /:id/read, …); this context mirrors it. A live SSE stream
 * (GET /api/notifications/stream, consumed via fetch+reader because browser
 * EventSource cannot send the bearer header) pushes `notification.new` events
 * the moment they are created, so the badge pops instantly and a toast appears
 * while the tab is visible. A 60 s count poll stays as the safety net for
 * other tabs/agents, and mutations are optimistic with server confirmation.
 * Mounts only inside the authenticated tree (root.tsx).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";

import { authFetch } from "~/lib/api";

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message?: string;
  link?: string;
  isRead: boolean;
  createdAt: string;
}

interface NotificationsContextType {
  items: NotificationItem[];
  unread: number;
  loading: boolean;
  /** Re-pull the tray list + unread count from the server. */
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  dismissAll: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextType | null>(null);

const POLL_MS = 60_000;
const TRAY_LIMIT = 20;
const TOAST_MS = 6_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<NotificationItem | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/notifications?limit=${TRAY_LIMIT}`);
      if (res.ok) {
        const data = (await res.json()) as {
          notifications?: NotificationItem[];
          unreadCount?: number;
        };
        setItems(data.notifications ?? []);
        setUnread(data.unreadCount ?? 0);
      }
    } catch {
      /* ignore — next poll/refresh retries */
    }
    setLoading(false);
  }, []);

  // Lightweight count poll — keeps the badge true when events land from other
  // tabs/agents between full refreshes.
  const pollCount = useCallback(async () => {
    try {
      const res = await authFetch("/api/notifications/count");
      if (res.ok) {
        const data = (await res.json()) as { unreadCount?: number };
        setUnread(data.unreadCount ?? 0);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // ── Live stream ────────────────────────────────────────────────────────────
  // Fetch + reader (bearer header), auto-reconnecting with capped backoff.
  // Events arrive as `event: notification.new\ndata: <json>\n\n` frames plus
  // `:ping` keepalive comments.
  useEffect(() => {
    let aborted = false;
    let backoff = RECONNECT_MIN_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const connect = async () => {
      controller = new AbortController();
      try {
        const res = await authFetch("/api/notifications/stream", {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const ev = /^event: (.+)$/m.exec(frame)?.[1];
            const dataMatch = /^data: (.+)$/m.exec(frame);
            if (ev !== "notification.new" || !dataMatch) continue;
            let notif: NotificationItem;
            try {
              notif = JSON.parse(dataMatch[1]) as NotificationItem;
            } catch {
              continue;
            }
            setItems((prev) =>
              prev.some((n) => n.id === notif.id) ? prev : [notif, ...prev].slice(0, TRAY_LIMIT),
            );
            setUnread((c) => c + 1);
            if (document.visibilityState === "visible") {
              setToast(notif);
              if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
            }
          }
        }
      } catch {
        /* network/auth hiccup — retry below */
      } finally {
        if (!aborted) {
          retryTimer = setTimeout(() => {
            backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
            void connect();
          }, backoff);
        }
      }
    };

    void connect();
    return () => {
      aborted = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(pollCount, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh, pollCount]);

  const markRead = useCallback(async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnread((c) => Math.max(0, c - 1));
    try {
      await authFetch(`/api/notifications/${id}/read`, { method: "POST" });
    } catch {
      /* next poll reconciles */
    }
  }, []);

  const dismiss = useCallback(async (id: string) => {
    setItems((prev) => prev.filter((n) => n.id !== id));
    setUnread((c) => Math.max(0, c - 1));
    try {
      await authFetch(`/api/notifications/${id}/dismiss`, { method: "POST" });
    } catch {
      /* next poll reconciles */
    }
  }, []);

  const dismissAll = useCallback(async () => {
    setItems([]);
    setUnread(0);
    try {
      await authFetch("/api/notifications/dismiss-all", { method: "POST" });
    } catch {
      /* next poll reconciles */
    }
  }, []);

  return (
    <NotificationsContext.Provider
      value={{ items, unread, loading, refresh, markRead, dismiss, dismissAll }}
    >
      {children}
      {toast && (
        <div
          role="status"
          onClick={() => {
            if (toast.link) navigate(toast.link);
            void markRead(toast.id);
            setToast(null);
          }}
          className="fixed bottom-4 right-4 z-[9999] max-w-xs cursor-pointer rounded-xl shadow-xl select-none"
          style={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            animation: "egg-in 0.25s ease",
          }}
        >
          <div className="px-4 py-3">
            <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary shrink-0" />
              {toast.title}
            </p>
            {toast.message && (
              <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{toast.message}</p>
            )}
          </div>
        </div>
      )}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextType {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationsProvider");
  return ctx;
}
