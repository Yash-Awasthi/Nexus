// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Users, UserPlus, Search, Loader2 } from "lucide-react";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastActive: string;
  initials: string;
}

/** Map a /api/v1/admin/users row (safeUserAdmin shape) onto the view model. */
function toViewUser(u: {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  active?: boolean;
  deletedAt?: string | null;
}): User {
  const initials = (u.name ?? u.email ?? "?")
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return {
    id: u.id,
    name: u.name ?? u.email,
    email: u.email,
    role: u.role,
    status:
      u.active === undefined
        ? u.deletedAt
          ? "deleted"
          : "active"
        : u.active
          ? "active"
          : "deleted",
    lastActive: "—",
    initials: initials || "?",
  };
}

const VALID_ROLES = ["owner", "admin", "member", "viewer"];

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  // (playtest round 4) This page previously rendered MOCK_USERS whenever the
  // fetch failed — a non-admin saw an imaginary roster as if real. Failures now
  // surface as an explicit error state.
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // ── Fetch users from the guarded v1 admin surface ────────────────────────
  useEffect(() => {
    fetch("/api/v1/admin/users")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setErr(
            r.status === 403
              ? "Admin access required — this page is restricted to platform administrators."
              : (body.error ?? `Failed to load users (${r.status})`),
          );
          return;
        }
        const data = await r.json();
        setUsers((Array.isArray(data) ? data : (data?.users ?? [])).map(toViewUser));
      })
      .catch(() => setErr("Could not reach the server."))
      .finally(() => setLoading(false));
  }, []);

  const filtered = users.filter(
    (u) =>
      !search ||
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  // Role update — persists to the guarded v1 surface (PATCH), surfacing
  // failures instead of leaving the row optimistically changed.
  const updateRole = async (userId: string, newRole: string) => {
    if (!VALID_ROLES.includes(newRole)) return;
    const prev = users;
    setUsers((rows) => rows.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
    const r = await fetch(`/api/v1/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    }).catch(() => null);
    if (!r || !r.ok) {
      setUsers(prev); // roll back the optimistic change
      setErr(
        r && r.status === 403
          ? "Admin access required."
          : `Role update failed${r ? ` (${r.status})` : " — network error"}.`,
      );
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">User Management</h1>
              <p className="text-sm text-muted-foreground">
                Manage users, roles, and access permissions
              </p>
            </div>
          </div>
          <Button size="sm" className="gap-2">
            <UserPlus className="size-3.5" />
            Invite User
          </Button>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users..."
            className="pl-8"
          />
        </div>

        {err && (
          <p className="text-red-500 text-sm" role="alert">
            {err}
          </p>
        )}

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : users.length === 0 && !err ? (
              <p className="text-center text-muted-foreground py-12 text-sm">No users found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                        User
                      </th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                        Email
                      </th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                        Role
                      </th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                        Status
                      </th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                        Last Active
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((user) => (
                      <tr key={user.id} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar className="size-7">
                              <AvatarFallback className="text-[10px]">
                                {user.initials}
                              </AvatarFallback>
                            </Avatar>
                            <span className="text-sm font-medium">{user.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">{user.email}</td>
                        <td className="px-4 py-3">
                          <Select value={user.role} onValueChange={(v) => updateRole(user.id, v)}>
                            <SelectTrigger className="w-28 h-6">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="editor">Editor</SelectItem>
                              <SelectItem value="viewer">Viewer</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${
                              user.status === "active" ? "text-green-400" : "text-zinc-400"
                            }`}
                          >
                            {user.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {user.lastActive}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
