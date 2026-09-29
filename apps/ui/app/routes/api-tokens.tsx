// SPDX-License-Identifier: Apache-2.0
/**
 * API Tokens — Personal Access Token management.
 *
 * Developers use PATs to authenticate API requests from scripts, CI, extensions.
 *
 * API:
 *   GET    /api/tokens        — list tokens (no secrets)
 *   POST   /api/tokens        — create token (plaintext returned once)
 *   DELETE /api/tokens/:id    — revoke token
 */
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  RefreshCw,
  CheckCircle,
  Clock,
  Shield,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PAToken {
  id: string;
  name: string;
  tier?: string;
  scopes: string[];
  prefix: string;
  createdAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// The enforced scope areas (lib/pat-scopes.ts in the API owns these — a scope
// restricts a token to one product area; empty selection = full access).
const AVAILABLE_SCOPES: { name: string; hint: string }[] = [
  { name: "chat", hint: "Chat sessions and streaming" },
  { name: "memory", hint: "Memory read/write" },
  { name: "council", hint: "Council deliberations and checkpoints" },
  { name: "sandbox", hint: "Sandbox execution" },
  { name: "research", hint: "Deep research" },
  { name: "search", hint: "Search and answers; all the embeddable widget needs" },
  { name: "ab", hint: "A/B arena" },
  { name: "threads", hint: "Conversation threads" },
  { name: "tokens", hint: "Manage API tokens" },
  { name: "auth", hint: "Identity endpoints" },
];

const TIER_COLORS: Record<string, string> = {
  admin: "bg-destructive/10 text-destructive  ",
  basic: "bg-primary/10 text-primary  ",
  limited: "bg-muted text-muted-foreground  ",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d?: string) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isExpired(d?: string | null) {
  if (!d) return false;
  return new Date(d).getTime() < Date.now();
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function APITokens() {
  const [tokens, setTokens] = useState<PAToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState({
    label: "",
    scopes: [] as string[],
    expiresInDays: "",
  });
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/tokens");
      if (r.ok) {
        const d = (await r.json()) as { tokens?: PAToken[] };
        setTokens(d.tokens ?? []);
      }
    } catch {
      /* the list stays as it was */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const toggleScope = useCallback((scope: string) => {
    setNewToken((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope)
        ? prev.scopes.filter((s) => s !== scope)
        : [...prev.scopes, scope],
    }));
  }, []);

  const createToken = useCallback(async () => {
    if (!newToken.label.trim()) {
      setErr("Label is required");
      return;
    }
    setCreating(true);
    setErr("");
    try {
      const r = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newToken.label.trim(),
          scopes: newToken.scopes,
          expiresInDays: newToken.expiresInDays ? parseInt(newToken.expiresInDays) : undefined,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setErr(d.message ?? d.error ?? "Creation failed");
        return;
      }
      const d = (await r.json()) as { token?: string };
      setCreatedSecret(d.token ?? null);
      setShowCreate(false);
      setNewToken({ label: "", scopes: [], expiresInDays: "" });
      loadTokens();
    } catch {
      setErr("Creation failed");
    } finally {
      setCreating(false);
    }
  }, [newToken, loadTokens]);

  const revokeToken = useCallback(async (id: string) => {
    if (!confirm("Revoke this token? Any scripts using it will stop working.")) return;
    setRevoking(id);
    try {
      await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      setTokens((prev) =>
        prev.map((t) => (t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t)),
      );
    } catch {
      /* the token stays listed as active */
    }
    setRevoking(null);
  }, []);

  const copySecret = useCallback(() => {
    if (!createdSecret) return;
    navigator.clipboard.writeText(createdSecret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  }, [createdSecret]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Page width="narrow">
      <PageHeader
        title="API tokens"
        description="Personal access tokens for scripts, CI and any OpenAI-compatible client."
        actions={
          <>
            <Button variant="ghost" size="icon-sm" onClick={loadTokens} aria-label="Refresh">
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus /> New token
            </Button>
          </>
        }
      />

      {/* New token secret — show once */}
      {createdSecret && (
        <Card className="border-success/30 bg-success/10">
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-success shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-success">
                  Token created — copy it now. You won't see it again.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="flex-1 bg-background rounded p-2 text-xs font-mono select-all border break-all">
                    {createdSecret}
                  </code>
                  <Button size="sm" variant="outline" onClick={copySecret}>
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 mr-1 text-success" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 mr-1" />
                        Copy
                      </>
                    )}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() => setCreatedSecret(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading tokens…
        </div>
      ) : tokens.length === 0 ? (
        <Card>
          <CardContent className="pt-12 pb-12 text-center space-y-4">
            <Key className="w-12 h-12 mx-auto text-muted-foreground opacity-40" />
            <div>
              <p className="font-medium">No tokens yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create a token to authenticate API requests from scripts and integrations
              </p>
            </div>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create first token
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {tokens.map((token) => {
            const expired = isExpired(token.expiresAt);
            return (
              <Card
                key={token.id}
                className={`${token.revokedAt ? "opacity-50" : ""} ${expired ? "border-warning/30" : ""}`}
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-medium text-sm">{token.name}</span>
                        <Badge className={TIER_COLORS[token.tier ?? ""] ?? ""}>
                          <Shield className="w-2.5 h-2.5 mr-1" />
                          {token.tier}
                        </Badge>
                        {token.revokedAt && (
                          <Badge variant="destructive" className="text-xs">
                            Revoked
                          </Badge>
                        )}
                        {expired && !token.revokedAt && (
                          <Badge
                            variant="outline"
                            className="text-warning border-warning/30 text-xs"
                          >
                            Expired
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-1 mb-2">
                        <code className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                          {token.prefix}…
                        </code>
                      </div>

                      <div className="flex flex-wrap gap-1 mb-2">
                        {token.scopes.slice(0, 6).map((s) => (
                          <Badge key={s} variant="secondary" className="text-xs font-normal">
                            {s}
                          </Badge>
                        ))}
                        {token.scopes.length > 6 && (
                          <Badge variant="secondary" className="text-xs font-normal">
                            +{token.scopes.length - 6} more
                          </Badge>
                        )}
                      </div>

                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Created {fmtDate(token.createdAt)}
                        </span>
                        {token.expiresAt && (
                          <span className={expired ? "text-warning" : ""}>
                            Expires {fmtDate(token.expiresAt)}
                          </span>
                        )}
                        {token.lastUsedAt && <span>Last used {fmtDate(token.lastUsedAt)}</span>}
                      </div>
                    </div>

                    {!token.revokedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => revokeToken(token.id)}
                        disabled={revoking === token.id}
                      >
                        {revoking === token.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Usage example */}
      <Card className="bg-muted/30">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs font-medium mb-2">OpenAI-compatible API</p>
          <p className="text-xs text-muted-foreground mb-2">
            Any OpenAI client works: set its base URL to{" "}
            <code className="font-mono break-all">{window.location.origin}/v1</code> and its API key
            to a token. Models are named provider/model — list them at /v1/models.
          </p>
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {`curl ${window.location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer nxk_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "<provider>/<model>", "messages": [{"role": "user", "content": "Hello"}]}'`}
          </pre>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create API Token</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Label *</label>
              <Input
                placeholder="e.g. CI pipeline, VS Code extension"
                value={newToken.label}
                onChange={(e) => setNewToken((t) => ({ ...t, label: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Scopes</label>
              <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                {AVAILABLE_SCOPES.map((scope) => (
                  <label
                    key={scope.name}
                    title={scope.hint}
                    className="flex items-center gap-2 cursor-pointer text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={newToken.scopes.includes(scope.name)}
                      onChange={() => toggleScope(scope.name)}
                      className="rounded"
                    />
                    <span className="font-mono">{scope.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Leave empty for full access. Selected scopes restrict this token to those areas
                only.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Expires in (days)</label>
              <Input
                type="number"
                placeholder="Leave blank = no expiry"
                value={newToken.expiresInDays}
                onChange={(e) => setNewToken((t) => ({ ...t, expiresInDays: e.target.value }))}
                min={1}
                max={3650}
              />
            </div>

            {err && <p className="text-destructive text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={createToken} disabled={creating || !newToken.label.trim()}>
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Key className="w-4 h-4 mr-2" />
              )}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
