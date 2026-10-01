// SPDX-License-Identifier: Apache-2.0
/**
 * Workspaces — create one, invite people by email, see who is in it. A company
 * is shared with a workspace from its Settings tab on /org.
 */
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { apiFetch } from "~/lib/api";

interface Workspace {
  id: string;
  name: string;
  role: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

interface Member {
  userId: string;
  name: string | null;
  email: string;
  role: string;
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  const run = (fn: () => Promise<void>) => {
    setError("");
    fn().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const load = useCallback(async () => {
    const { workspaces: list } = await apiFetch<{ workspaces: Workspace[] }>("/api/v1/workspaces");
    setWorkspaces(list);
    setSelected((s) => s ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => run(load), [load]);

  const current = workspaces.find((w) => w.id === selected);
  const canInvite = current?.role === "owner" || current?.role === "admin";

  const loadMembers = useCallback(async () => {
    if (!selected) return;
    const [b, inv] = await Promise.all([
      apiFetch<{ members: Member[] }>(`/api/v1/workspaces/${selected}/members`),
      canInvite
        ? apiFetch<{ invitations: Invitation[] }>(`/api/v1/workspaces/${selected}/invitations`)
        : { invitations: [] },
    ]);
    setMembers(b.members);
    setInvitations(inv.invitations);
  }, [selected, canInvite]);

  useEffect(() => {
    setLink("");
    run(loadMembers);
  }, [loadMembers]);

  const manage = (url: string, method: string, body?: unknown) =>
    run(async () => {
      await apiFetch(`/api/v1/workspaces/${selected}${url}`, { method, json: body });
      await loadMembers();
    });

  const create = () =>
    run(async () => {
      const ws = await apiFetch<{ id: string }>("/api/v1/workspaces", {
        method: "POST",
        json: { name: name.trim() },
      });
      setName("");
      setSelected(ws.id);
      await load();
    });

  const invite = () =>
    run(async () => {
      const r = await apiFetch<{ invitationToken: string }>(
        `/api/v1/workspaces/${selected}/invitations`,
        { method: "POST", json: { email: email.trim() } },
      );
      setEmail("");
      setLink(`${window.location.origin}/invitations/${r.invitationToken}`);
      await loadMembers();
    });

  return (
    <Page width="narrow">
      <PageHeader
        title="Workspaces"
        description="Invite people to a workspace, then share a company with it from the company's Settings tab."
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create();
        }}
      >
        <Input
          aria-label="New workspace name"
          placeholder="New workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={!name.trim()}>
          Create
        </Button>
      </form>

      {workspaces.length > 0 && (
        <select
          aria-label="Workspace"
          className="w-full rounded-md border bg-background p-2 text-sm"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.role})
            </option>
          ))}
        </select>
      )}

      {current && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Members</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1 text-sm">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate">{m.name ?? m.email}</span>
                  {canInvite && m.role !== "owner" ? (
                    <>
                      <select
                        aria-label={`Role for ${m.email}`}
                        className="rounded-md border bg-background p-1 text-xs"
                        value={m.role}
                        onChange={(e) =>
                          manage(`/members/${m.userId}`, "PATCH", { role: e.target.value })
                        }
                      >
                        {["admin", "member", "viewer"].map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${m.email}`}
                        onClick={() => {
                          if (window.confirm(`Remove ${m.email} from this workspace?`))
                            manage(`/members/${m.userId}`, "DELETE");
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{m.role}</span>
                  )}
                </li>
              ))}
            </ul>
            {invitations.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  Pending invitations
                </p>
                <ul aria-label="Pending invitations" className="space-y-1 text-sm">
                  {invitations.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate">{i.email}</span>
                      <span className="text-muted-foreground">{i.role}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Revoke invitation for ${i.email}`}
                        onClick={() => manage(`/invitations/${i.id}`, "DELETE")}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canInvite && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (email.trim()) invite();
                }}
              >
                <Input
                  type="email"
                  aria-label="Invite by email"
                  placeholder="teammate@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button type="submit" disabled={!email.trim()}>
                  Invite
                </Button>
              </form>
            )}
            {link && (
              <p className="text-sm break-all">
                Send this link to them; it works only for that email:{" "}
                <a className="underline" href={link}>
                  {link}
                </a>
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
