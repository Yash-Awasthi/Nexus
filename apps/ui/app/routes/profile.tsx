// SPDX-License-Identifier: Apache-2.0
import { AlertTriangle, Check, Download, Loader2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Route } from "./+types/profile";

import { MfaSection } from "~/components/mfa-section";
import { Page, PageHeader, Section, SettingRow } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useAuth } from "~/context/AuthContext";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile · Nexus" }];
}

export default function ProfilePage() {
  const { user, setUser } = useAuth();
  const displayName = user?.username ?? "User";
  const email = user?.email ?? "";
  const role = user?.role ?? "user";

  const [name, setName] = useState(displayName);
  // Persisted in the per-user preferences store (/settings/preferences) —
  // PATCH /auth/me has no such column, and the chat stream injects this as a
  // system message.
  const [customInstructions, setCustomInstructions] = useState("");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingInstructions, setIsSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Sync user data once loaded
  useEffect(() => {
    if (user) {
      setName(user.username ?? "");
    }
  }, [user?.id]);

  // Load saved custom instructions from the per-user preferences store.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetch("/api/settings/preferences").catch(() => null);
      const p = r?.ok
        ? ((await r.json().catch(() => null)) as { customInstructions?: unknown } | null)
        : null;
      if (!cancelled && typeof p?.customInstructions === "string") {
        setCustomInstructions(p.customInstructions);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const initials =
    (name || displayName)
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "?";

  async function toggleEditing() {
    if (!isEditing) return setIsEditing(true);
    setAccountError(null);
    const res = await fetch("/api/v1/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setAccountError(data.message ?? data.error ?? `Save failed (${res.status})`);
      return;
    }
    if (user) setUser({ ...user, username: name.trim() || user.username });
    setIsEditing(false);
  }

  async function deleteAllConversations() {
    setDeleting(true);
    setAccountError(null);
    try {
      const res = await fetch("/api/threads?limit=1000");
      const data = (await res.json()) as { threads?: { id: string }[] } | { id: string }[];
      const threads = Array.isArray(data) ? data : (data.threads ?? []);
      for (const t of threads) {
        const del = await fetch(`/api/threads/${encodeURIComponent(t.id)}`, { method: "DELETE" });
        if (!del.ok) throw new Error(`Could not delete a conversation (${del.status})`);
      }
      setDeleteDialogOpen(false);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function exportData() {
    setAccountError(null);
    try {
      const get = async (url: string): Promise<unknown> => {
        const r = await fetch(url);
        return r.ok ? ((await r.json()) as unknown) : null;
      };
      const list = (await get("/api/threads?limit=1000")) as
        { threads?: { id: string }[] } | { id: string }[] | null;
      const threads = Array.isArray(list) ? list : (list?.threads ?? []);
      const conversations = await Promise.all(
        threads.map(async (t) => ({
          ...t,
          messages: await get(`/api/threads/${encodeURIComponent(t.id)}/messages`),
        })),
      );
      const blob = new Blob(
        [
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              account: await get("/api/v1/auth/me"),
              preferences: await get("/api/settings/preferences"),
              conversations,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nexus-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Export failed");
    }
  }

  async function handleSaveInstructions() {
    setIsSavingInstructions(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customInstructions }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `Save failed (${res.status})`);
      }
      setInstructionsSaved(true);
      setTimeout(() => setInstructionsSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSavingInstructions(false);
    }
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Profile"
        description="Your account, the standing instructions the council follows, and your data."
      />

      <Section title="Account">
        <div className="flex items-center gap-4 py-2">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/15 text-lg font-semibold text-primary">
            {initials}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            {isEditing ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void toggleEditing();
                }}
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Name"
                  autoFocus
                  className="max-w-xs"
                />
                <Button type="submit" size="sm">
                  Save
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{name || displayName}</p>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit name"
                  onClick={() => setIsEditing(true)}
                >
                  <Pencil />
                </Button>
              </div>
            )}
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {email}
              <Badge variant="secondary" className="capitalize">
                {role}
              </Badge>
            </p>
          </div>
        </div>
        {accountError && <p className="pb-2 text-sm text-destructive">{accountError}</p>}
      </Section>

      <Section
        title="Standing instructions"
        description="Every council member follows these on every question, e.g. your role, your stack or how you like answers."
      >
        <div className="space-y-2 py-2">
          <Textarea
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value.slice(0, 2000))}
            placeholder="I run a 12-person SaaS team. Prefer concrete numbers and name the trade-offs."
            rows={4}
            aria-label="Standing instructions"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{customInstructions.length}/2000</span>
            <div className="flex items-center gap-2">
              {saveError && <span className="text-xs text-destructive">{saveError}</span>}
              {instructionsSaved && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="size-3.5" /> Saved
                </span>
              )}
              <Button
                size="sm"
                onClick={() => void handleSaveInstructions()}
                disabled={isSavingInstructions}
              >
                {isSavingInstructions && <Loader2 className="animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <MfaSection />

      <Section title="Your data">
        <SettingRow
          label="Export everything"
          description="Your account, preferences and every deliberation as one JSON file."
        >
          <Button variant="outline" size="sm" onClick={() => void exportData()}>
            <Download /> Export
          </Button>
        </SettingRow>
        <SettingRow
          label="Delete all deliberations"
          description="Removes every thread and its messages. This can't be undone."
        >
          <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 /> Delete all
          </Button>
        </SettingRow>
      </Section>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" /> Delete all deliberations?
            </DialogTitle>
            <DialogDescription>
              Every thread and message goes, on every device. Export first if you may want them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void deleteAllConversations()}
              disabled={deleting}
            >
              {deleting && <Loader2 className="animate-spin" />}
              Delete all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
