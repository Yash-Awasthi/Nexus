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
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Clock,
  Shield,
  Eye,
  EyeOff,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PAToken {
  id: string;
  label: string;
  tier: "admin" | "basic" | "limited";
  scopes: string[];
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revoked: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AVAILABLE_SCOPES = [
  "read:conversations",
  "write:conversations",
  "read:kb",
  "write:kb",
  "read:workflows",
  "write:workflows",
  "read:memory",
  "write:memory",
  "read:providers",
  "write:providers",
  "admin:users",
  "admin:system",
];

const TIER_DESCRIPTIONS: Record<string, string> = {
  admin:   "Full admin access",
  basic:   "Standard user operations",
  limited: "Read-only restricted access",
};

const TIER_COLORS: Record<string, string> = {
  admin:   "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  basic:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  limited: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d?: string) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function isExpired(d?: string) {
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
    tier: "basic" as "admin" | "basic" | "limited",
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
        const d = await r.json();
        setTokens(d.tokens ?? d);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  const toggleScope = useCallback((scope: string) => {
    setNewToken(prev => ({
      ...prev,
      scopes: prev.scopes.includes(scope)
        ? prev.scopes.filter(s => s !== scope)
        : [...prev.scopes, scope],
    }));
  }, []);

  const createToken = useCallback(async () => {
    if (!newToken.label.trim()) { setErr("Label is required"); return; }
    setCreating(true);
    setErr("");
    try {
      const r = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newToken.label.trim(),
          tier: newToken.tier,
          scopes: newToken.scopes,
          expiresInDays: newToken.expiresInDays ? parseInt(newToken.expiresInDays) : undefined,
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        setErr(d.error ?? "Creation failed");
        return;
      }
      const d = await r.json();
      setCreatedSecret(d.token ?? d.plaintext ?? null);
      setShowCreate(false);
      setNewToken({ label: "", tier: "basic", scopes: [], expiresInDays: "" });
      loadTokens();
    } catch { setErr("Creation failed"); }
    finally { setCreating(false); }
  }, [newToken, loadTokens]);

  const revokeToken = useCallback(async (id: string) => {
    if (!confirm("Revoke this token? Any scripts using it will stop working.")) return;
    setRevoking(id);
    try {
      await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      setTokens(prev => prev.map(t => t.id === id ? { ...t, revoked: true } : t));
    } catch {}
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
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Key className="w-6 h-6 text-amber-500" />
            API Tokens
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Personal access tokens for scripting, CI, and API integrations
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={loadTokens}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-1" />
            New token
          </Button>
        </div>
      </div>

      {/* New token secret — show once */}
      {createdSecret && (
        <Card className="border-green-400 dark:border-green-700 bg-green-50 dark:bg-green-950/20">
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-green-700 dark:text-green-400">
                  Token created — copy it now. You won't see it again.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="flex-1 bg-background rounded p-2 text-xs font-mono select-all border break-all">
                    {createdSecret}
                  </code>
                  <Button size="sm" variant="outline" onClick={copySecret}>
                    {copied
                      ? <><Check className="w-3 h-3 mr-1 text-green-500" />Copied</>
                      : <><Copy className="w-3 h-3 mr-1" />Copy</>}
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
          {tokens.map(token => {
            const expired = isExpired(token.expiresAt);
            return (
              <Card
                key={token.id}
                className={`${token.revoked ? "opacity-50" : ""} ${expired ? "border-orange-300" : ""}`}
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-medium text-sm">{token.label}</span>
                        <Badge className={TIER_COLORS[token.tier] ?? ""}>
                          <Shield className="w-2.5 h-2.5 mr-1" />
                          {token.tier}
                        </Badge>
                        {token.revoked && (
                          <Badge variant="destructive" className="text-xs">Revoked</Badge>
                        )}
                        {expired && !token.revoked && (
                          <Badge variant="outline" className="text-orange-600 border-orange-400 text-xs">
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
                        {token.scopes.slice(0, 6).map(s => (
                          <Badge key={s} variant="secondary" className="text-xs font-normal">{s}</Badge>
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
                          <span className={expired ? "text-orange-600" : ""}>
                            Expires {fmtDate(token.expiresAt)}
                          </span>
                        )}
                        {token.lastUsedAt && (
                          <span>Last used {fmtDate(token.lastUsedAt)}</span>
                        )}
                      </div>
                    </div>

                    {!token.revoked && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-500 hover:text-red-600 hover:bg-red-50 shrink-0"
                        onClick={() => revokeToken(token.id)}
                        disabled={revoking === token.id}
                      >
                        {revoking === token.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />}
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
          <p className="text-xs font-medium mb-2">Usage</p>
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
{`curl https://your-nexus.app/api/chat \\
  -H "Authorization: Bearer nexus_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello"}'`}
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
                onChange={e => setNewToken(t => ({ ...t, label: e.target.value }))}
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Tier</label>
              <Select
                value={newToken.tier}
                onValueChange={v => setNewToken(t => ({ ...t, tier: v as any }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TIER_DESCRIPTIONS).map(([tier, desc]) => (
                    <SelectItem key={tier} value={tier}>
                      <span className="capitalize">{tier}</span>
                      <span className="text-muted-foreground ml-2 text-xs">— {desc}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Scopes</label>
              <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                {AVAILABLE_SCOPES.map(scope => (
                  <label key={scope} className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={newToken.scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      className="rounded"
                    />
                    <span className="font-mono">{scope}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Leave empty for full tier access</p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Expires in (days)</label>
              <Input
                type="number"
                placeholder="Leave blank = no expiry"
                value={newToken.expiresInDays}
                onChange={e => setNewToken(t => ({ ...t, expiresInDays: e.target.value }))}
                min={1}
                max={3650}
              />
            </div>

            {err && <p className="text-red-500 text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={createToken} disabled={creating || !newToken.label.trim()}>
              {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Key className="w-4 h-4 mr-2" />}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
