// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys on the profile: add one from this device, see and remove the others.
 *
 * API: GET /api/v1/auth/passkeys · DELETE /api/v1/auth/passkeys/:id (adding: lib/passkeys.ts)
 */
import { KeyRound, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Section } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { apiFetch } from "~/lib/api";
import { timeAgo } from "~/lib/org";
import { addPasskey, passkeysSupported } from "~/lib/passkeys";

interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function PasskeysSection() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      apiFetch<{ available: boolean; passkeys: Passkey[] }>("/api/v1/auth/passkeys")
        .then((r) => setKeys(r.available ? r.passkeys : null))
        .catch(() => setKeys(null)),
    [],
  );
  useEffect(() => {
    if (passkeysSupported()) void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // Unsupported browser, desktop host or a server with no public address: nothing to offer.
  if (keys === null) return null;
  return (
    <Section
      title="Passkeys"
      description="Sign in with this device's screen lock instead of a password. A passkey counts as two-factor sign-in."
    >
      <div className="space-y-3 py-3">
        {keys.length > 0 && (
          <ul className="divide-y rounded-md border" data-testid="passkeys-list">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm">
                    <KeyRound className="size-3.5" /> {k.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Added {timeAgo(k.createdAt)} · last used {timeAgo(k.lastUsedAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      apiFetch(`/api/v1/auth/passkeys/${encodeURIComponent(k.id)}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await addPasskey(name.trim() || "Passkey");
              setName("");
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="passkey-name">Name for this passkey</Label>
            <Input
              id="passkey-name"
              value={name}
              maxLength={64}
              placeholder="e.g. Work laptop"
              onChange={(e) => setName(e.target.value)}
              className="w-56"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Add a passkey
          </Button>
        </form>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </div>
    </Section>
  );
}
