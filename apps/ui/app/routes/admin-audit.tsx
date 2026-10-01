// SPDX-License-Identifier: Apache-2.0
import { Search, RefreshCw, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";

/** One row of the hash-chained audit trail, as `/api/admin/audit-logs` returns it. */
interface AuditEntry {
  id: string;
  ts: string;
  user: string;
  action: string;
  resource: string;
}

const ACTION_COLORS: Record<string, string> = {
  "user.login": "text-success",
  "user.role_change": "text-warning",
  "config.update": "text-primary",
  "chat.create": "text-primary",
  "chat.delete": "text-destructive",
  "kb.upload": "text-primary",
  "workflow.run": "text-success",
  "workflow.create": "text-success",
  "memory.compact": "text-warning",
  "prompt.update": "text-primary",
};

export default function AdminAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const fetchLogs = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/admin/audit-logs")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { logs?: AuditEntry[] }) => setEntries(data.logs ?? []))
      .catch((err: Error) => setError(`Could not load the audit log (${err.message}).`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // ponytail: filters the newest 200 rows the endpoint returns; older rows need server paging.
  const q = search.toLowerCase();
  const filtered = entries.filter((entry) => {
    const day = entry.ts.slice(0, 10);
    if (dateFrom && day < dateFrom) return false;
    if (dateTo && day > dateTo) return false;
    return (
      !q ||
      entry.user.toLowerCase().includes(q) ||
      entry.action.toLowerCase().includes(q) ||
      entry.resource.toLowerCase().includes(q)
    );
  });

  return (
    <Page width="wide">
      <PageHeader
        title="Audit log"
        description="Every sign-in, key change and configuration change, oldest entries hash-chained."
        actions={
          <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        }
      />

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by user, action, resource, or IP..."
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>From:</span>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-36 h-7"
          />
          <span>To:</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-36 h-7"
          />
        </div>
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
                      Timestamp
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      User
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Action
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Resource
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => (
                    <tr key={entry.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <code className="text-xs font-mono text-muted-foreground">
                          {new Date(entry.ts).toLocaleString()}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-sm">{entry.user}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className={"text-[10px] font-mono " + (ACTION_COLORS[entry.action] ?? "")}
                        >
                          {entry.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-xs font-mono text-muted-foreground">
                          {entry.resource}
                        </code>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-4 py-8 text-center text-sm text-muted-foreground"
                      >
                        {error ??
                          (entries.length
                            ? "No audit entries match your filters."
                            : "Nothing has been audited yet.")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
