// SPDX-License-Identifier: Apache-2.0
/**
 * NotificationBell — sidebar tray. Pure presentation over the shared
 * NotificationsContext (unread badge + recent list + mark/dismiss), with only
 * local open/outside-click state. The context polls the count; the tray list
 * refreshes when opened and after every mutation.
 */
import { Bell, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useNotifications } from "~/context/NotificationsContext";

export function NotificationBell() {
  const { items, unread, loading, refresh, markRead, dismiss, dismissAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Item click: mark read via the shared tray owner, then follow the link
  // (emitters set /deep-research?id=… or /projects) — same behavior as the
  // dashboard Activity feed, so the research loop navigates from every surface.
  const openNotification = (id: string, link?: string) => {
    const n = items.find((x) => x.id === id);
    if (n && !n.isRead) void markRead(n.id);
    if (link) {
      navigate(link);
      setOpen(false);
    }
  };

  // Refresh the tray list whenever the panel opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={panelRef} className="relative group-data-[collapsible=icon]:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center size-7 rounded-md hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
        title="Notifications"
      >
        <Bell className="size-3.5" />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground"
            style={{ minWidth: "14px", height: "14px", padding: "0 2px" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute left-full top-0 ml-2 z-50 rounded-xl shadow-xl"
          style={{
            width: "280px",
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
          }}
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
            <span className="text-xs font-semibold">Notifications</span>
            {items.length > 0 && (
              <button
                onClick={() => void dismissAll()}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Dismiss all
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                Loading…
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <Bell className="size-5 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No notifications</p>
              </div>
            ) : (
              items.slice(0, 8).map((n) => (
                <div
                  key={n.id}
                  onClick={() => openNotification(n.id, n.link)}
                  className="flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors group/item"
                  style={{ borderBottom: "1px solid hsl(var(--border)/0.4)" }}
                >
                  {!n.isRead && (
                    <span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                  )}
                  <div className={`flex-1 min-w-0 ${n.isRead ? "pl-3.5" : ""}`}>
                    <p
                      className={`text-xs font-medium leading-tight ${n.isRead ? "text-muted-foreground" : ""}`}
                    >
                      {n.title}
                    </p>
                    {n.message && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                        {n.message}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void dismiss(n.id);
                    }}
                    className="shrink-0 mt-0.5 opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground transition-all"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
