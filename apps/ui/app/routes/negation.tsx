// SPDX-License-Identifier: Apache-2.0
/**
 * Negation — detect, store, and inject negation rules into conversations.
 *
 * Tab 1: Detect — analyze text for negation patterns
 * Tab 2: Manage — view and delete rules for a conversation
 * Tab 3: Inject — inject negation rules into an active conversation
 *
 * API:
 *   POST   /api/negation/detect
 *   POST   /api/negation/add
 *   GET    /api/negation/:convId
 *   DELETE /api/negation/:convId/:ruleId
 *   DELETE /api/negation/:convId
 *   POST   /api/negation/inject
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Loader2, AlertTriangle, Trash2, Plus, Zap, Search } from "lucide-react";

interface NegationRule {
  id: string;
  pattern: string;
  type?: string;
  createdAt?: string;
}

interface DetectResult {
  found: boolean;
  patterns?: { pattern: string; span?: string; type?: string }[];
  count?: number;
}

// ─── Detect Tab ───────────────────────────────────────────────────────────────

function DetectTab() {
  const [text, setText] = useState("");
  const [convId, setConvId] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [err, setErr] = useState("");
  const [added, setAdded] = useState(false);

  const detect = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true);
    setErr("");
    setResult(null);
    setAdded(false);
    const r = await fetch("/api/negation/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Detection failed");
    setLoading(false);
  }, [text]);

  const addAll = useCallback(async () => {
    if (!result?.patterns?.length || !convId.trim()) return;
    setAdding(true);
    await fetch("/api/negation/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: convId.trim(), patterns: result.patterns }),
    }).catch(() => null);
    setAdded(true);
    setAdding(false);
  }, [result, convId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={4}
            placeholder="Enter text to analyze for negation patterns…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="resize-none"
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={detect} disabled={loading || !text.trim()}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Detecting…
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Detect
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className={result.found ? "border-orange-200 dark:border-orange-800" : ""}>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center gap-2">
              {result.found ? (
                <AlertTriangle className="w-4 h-4 text-orange-500" />
              ) : (
                <span className="text-sm text-muted-foreground">No negation patterns found</span>
              )}
              {result.found && (
                <span className="text-sm font-medium">
                  {result.count ?? result.patterns?.length} pattern(s) detected
                </span>
              )}
            </div>
            {result.patterns?.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Badge variant="secondary" className="text-xs">
                  {p.type ?? "negation"}
                </Badge>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded flex-1 truncate">
                  {p.span ?? p.pattern}
                </code>
              </div>
            ))}
            {result.found && result.patterns?.length && (
              <div className="flex items-center gap-2 pt-2 border-t border-border">
                <Input
                  placeholder="Conversation ID to save rules to…"
                  value={convId}
                  onChange={(e) => setConvId(e.target.value)}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  onClick={addAll}
                  disabled={adding || !convId.trim() || added}
                  variant="outline"
                >
                  {adding ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : added ? (
                    "Saved"
                  ) : (
                    <>
                      <Plus className="w-3 h-3 mr-1" />
                      Save
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Manage Tab ───────────────────────────────────────────────────────────────

function ManageTab() {
  const [convId, setConvId] = useState("");
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<NegationRule[]>([]);
  const [err, setErr] = useState("");
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    if (!convId.trim()) return;
    setLoading(true);
    setErr("");
    setRules([]);
    const r = await fetch(`/api/negation/${encodeURIComponent(convId.trim())}`).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setRules(d.rules ?? d ?? []);
    } else setErr("Failed to load rules");
    setLoading(false);
  }, [convId]);

  const deleteRule = async (ruleId: string) => {
    await fetch(`/api/negation/${encodeURIComponent(convId)}/${ruleId}`, {
      method: "DELETE",
    }).catch(() => null);
    setRules((prev) => prev.filter((r) => r.id !== ruleId));
  };

  const clearAll = useCallback(async () => {
    setClearing(true);
    await fetch(`/api/negation/${encodeURIComponent(convId)}`, { method: "DELETE" }).catch(
      () => null,
    );
    setRules([]);
    setClearing(false);
  }, [convId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Conversation ID…"
              value={convId}
              onChange={(e) => setConvId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              className="flex-1"
            />
            <Button onClick={load} disabled={loading || !convId.trim()}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load"}
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </CardContent>
      </Card>

      {rules.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>{rules.length} rule(s)</span>
              <Button size="sm" variant="destructive" onClick={clearAll} disabled={clearing}>
                {clearing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <>
                    <Trash2 className="w-3 h-3 mr-1" />
                    Clear All
                  </>
                )}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center gap-2 text-sm">
                {rule.type && (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {rule.type}
                  </Badge>
                )}
                <code className="flex-1 text-xs bg-muted px-1.5 py-0.5 rounded truncate">
                  {rule.pattern}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-red-400 shrink-0"
                  onClick={() => deleteRule(rule.id)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {!loading && rules.length === 0 && convId && (
        <Card>
          <CardContent className="pt-8 pb-8 text-center text-muted-foreground text-sm">
            No rules for this conversation
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Inject Tab ───────────────────────────────────────────────────────────────

function InjectTab() {
  const [convId, setConvId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ message?: string; injected?: number } | null>(null);
  const [err, setErr] = useState("");

  const inject = useCallback(async () => {
    if (!convId.trim()) return;
    setLoading(true);
    setErr("");
    setResult(null);
    const r = await fetch("/api/negation/inject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: convId.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Injection failed");
    setLoading(false);
  }, [convId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Inject stored negation rules into an active conversation context.
          </p>
          <Input
            placeholder="Conversation ID…"
            value={convId}
            onChange={(e) => setConvId(e.target.value)}
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={inject} disabled={loading || !convId.trim()}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Injecting…
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 mr-2" />
                Inject Rules
              </>
            )}
          </Button>
        </CardContent>
      </Card>
      {result && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-4">
            <p className="text-sm font-medium text-green-700 dark:text-green-400">
              {result.message ?? "Injected successfully"}
            </p>
            {result.injected !== undefined && (
              <p className="text-xs text-muted-foreground mt-1">
                {result.injected} rule(s) injected
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Negation() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <AlertTriangle className="w-6 h-6 text-orange-500" />
          Negation
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Detect, store, and inject negation rules into conversation contexts
        </p>
      </div>
      <Tabs defaultValue="detect">
        <TabsList>
          <TabsTrigger value="detect">
            <Search className="w-4 h-4 mr-1" />
            Detect
          </TabsTrigger>
          <TabsTrigger value="manage">Manage</TabsTrigger>
          <TabsTrigger value="inject">
            <Zap className="w-4 h-4 mr-1" />
            Inject
          </TabsTrigger>
        </TabsList>
        <TabsContent value="detect" className="mt-4">
          <DetectTab />
        </TabsContent>
        <TabsContent value="manage" className="mt-4">
          <ManageTab />
        </TabsContent>
        <TabsContent value="inject" className="mt-4">
          <InjectTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
