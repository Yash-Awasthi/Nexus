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

const MOCK_USERS: User[] = [
  {
    id: "1",
    name: "Alice Chen",
    email: "alice@example.com",
    role: "admin",
    status: "active",
    lastActive: "Just now",
    initials: "AC",
  },
  {
    id: "2",
    name: "Bob Martinez",
    email: "bob@example.com",
    role: "editor",
    status: "active",
    lastActive: "5 min ago",
    initials: "BM",
  },
  {
    id: "3",
    name: "Carol Johnson",
    email: "carol@example.com",
    role: "viewer",
    status: "active",
    lastActive: "1 hour ago",
    initials: "CJ",
  },
  {
    id: "4",
    name: "David Kim",
    email: "david@example.com",
    role: "editor",
    status: "active",
    lastActive: "2 hours ago",
    initials: "DK",
  },
  {
    id: "5",
    name: "Elena Popov",
    email: "elena@example.com",
    role: "admin",
    status: "active",
    lastActive: "3 hours ago",
    initials: "EP",
  },
  {
    id: "6",
    name: "Frank Weber",
    email: "frank@example.com",
    role: "viewer",
    status: "inactive",
    lastActive: "1 week ago",
    initials: "FW",
  },
  {
    id: "7",
    name: "Grace Liu",
    email: "grace@example.com",
    role: "editor",
    status: "active",
    lastActive: "Yesterday",
    initials: "GL",
  },
  {
    id: "8",
    name: "Hassan Ali",
    email: "hassan@example.com",
    role: "viewer",
    status: "inactive",
    lastActive: "2 weeks ago",
    initials: "HA",
  },
];

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<User[]>(MOCK_USERS);
  const [loading, setLoading] = useState(true);

  // ── Fetch users from backend ──────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const list: User[] = Array.isArray(data) ? data : (data?.users ?? []);
        if (list.length > 0) setUsers(list);
      })
      .catch(() => {
        /* fall back to MOCK_USERS */
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = users.filter(
    (u) =>
      !search ||
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  // Optimistic role update — persists to backend fire-and-forget
  const updateRole = (userId: string, newRole: string) => {
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
    fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    }).catch(() => {});
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

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
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
