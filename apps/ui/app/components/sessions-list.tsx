// SPDX-License-Identifier: Apache-2.0
/**
 * Signed-in devices for one account: end one, or end them all. Without `userId`
 * it is the caller's own list; with it, an admin's view of that user.
 *
 * API: GET|DELETE /api/v1/auth/sessions[/:id] · POST /api/v1/auth/sessions/revoke-all
 *      GET|DELETE /api/v1/admin/users/:id/sessions[/:sid]
 */
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Section } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/context/AuthContext";
import { apiFetch } from "~/lib/api";
import { timeAgo } from "~/lib/org";

interface Session {
  id: string;
  userAgent: string | null;
  createdAt: string;
  current?: boolean;
}

export function SessionsList({ userId }: { userId?: string }) {
  const { logout } = useAuth();
  const base = userId
    ? `/api/v1/admin/users/${encodeURIComponent(userId)}/sessions`
    : "/api/v1/auth/sessions";
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      apiFetch<{ sessions: Session[] }>(base)
        .then((r) => setSessions(r.sessions))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [base],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const end = (s: Session) =>
    run(async () => {
      await apiFetch(`${base}/${s.id}`, { method: "DELETE" });
      if (s.current) logout();
      else await load();
    });

  const endAll = () =>
    run(async () => {
      if (userId) {
        await apiFetch(base, { method: "DELETE" });
        await load();
      } else {
        await apiFetch(`${base}/revoke-all`, { method: "POST" });
        logout();
      }
    });

  // Own list loading or unavailable (a local-only desktop account has none): hide like MfaSection.
  if (sessions === null && !userId) return null;
  if (sessions === null) {
    return error ? (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    ) : (
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    );
  }
  const body = (
    <div className="space-y-2">
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No signed-in devices.</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="sessions-list">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {s.userAgent ?? "Unknown device"}
                  {s.current && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      This device
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Signed in {timeAgo(s.createdAt)}</p>
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void end(s)}>
                Sign out
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {sessions.length > 0 && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void endAll()}>
          {busy && <Loader2 className="animate-spin" />}
          Sign out everywhere
        </Button>
      )}
    </div>
  );
  if (userId) return body;
  return (
    <Section
      title="Signed-in devices"
      description="Everywhere your account is signed in. Signing a device out ends its session at once."
    >
      <div className="py-3">{body}</div>
    </Section>
  );
}
