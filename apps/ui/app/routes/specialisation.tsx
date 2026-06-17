/**
 * Specialisation — detect domain expertise and apply specialist routing.
 *
 * Tab 1: Domains — view available specialisation domains
 * Tab 2: Detect — detect the domain(s) of a prompt
 * Tab 3: Apply — apply domain specialisation to a session
 *
 * API:
 *   GET  /api/specialisation/domains
 *   POST /api/specialisation/detect
 *   POST /api/specialisation/apply
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Loader2, Microscope, Search, Play, CheckCircle } from "lucide-react";

interface Domain {
  id: string;
  name: string;
  description?: string;
  modelHint?: string;
  enabled?: boolean;
}

interface DetectResult {
  domains: { id: string; name: string; confidence: number }[];
  primary?: string;
}

interface ApplyResult {
  message?: string;
  domain: string;
  model?: string;
}

// ─── Domains Tab ──────────────────────────────────────────────────────────────

function DomainsTab() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/specialisation/domains")
      .then(r => r.ok ? r.json() : { domains: [] })
      .then(d => setDomains(d.domains ?? d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
      <Loader2 className="w-4 h-4 animate-spin" />Loading domains…
    </div>
  );

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {domains.map(d => (
        <Card key={d.id} className={d.enabled === false ? "opacity-50" : ""}>
          <CardContent className="pt-4 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">{d.name}</span>
              <Badge variant="secondary" className="text-xs">{d.id}</Badge>
            </div>
            {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
            {d.modelHint && <p className="text-xs text-muted-foreground">Model hint: <code className="bg-muted px-1 rounded">{d.modelHint}</code></p>}
          </CardContent>
        </Card>
      ))}
      {domains.length === 0 && (
        <Card className="col-span-2">
          <CardContent className="pt-8 pb-8 text-center text-muted-foreground">No domains configured</CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Detect Tab ───────────────────────────────────────────────────────────────

function DetectTab() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [err, setErr] = useState("");

  const detect = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/specialisation/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Detection failed");
    setLoading(false);
  }, [text]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={4}
            placeholder="Enter a prompt or text to detect its domain specialisation…"
            value={text}
            onChange={e => setText(e.target.value)}
            className="resize-none"
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={detect} disabled={loading || !text.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Detecting…</> : <><Search className="w-4 h-4 mr-2" />Detect Domain</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            {result.primary && (
              <div className="flex items-center gap-2">
                <Microscope className="w-4 h-4 text-fuchsia-500" />
                <span className="text-sm font-medium">Primary domain:</span>
                <Badge className="bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-400">{result.primary}</Badge>
              </div>
            )}
            {result.domains.length > 0 && (
              <div className="space-y-2">
                {result.domains.map(d => (
                  <div key={d.id} className="flex items-center gap-3">
                    <span className="text-sm w-32 truncate">{d.name}</span>
                    <div className="flex-1 bg-muted rounded-full h-2">
                      <div className="bg-fuchsia-500 h-2 rounded-full" style={{ width: `${d.confidence * 100}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(d.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Apply Tab ────────────────────────────────────────────────────────────────

function ApplyTab() {
  const [sessionId, setSessionId] = useState("");
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [err, setErr] = useState("");

  const apply = useCallback(async () => {
    if (!sessionId.trim() || !domain.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/specialisation/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId.trim(), domain: domain.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Apply failed");
    setLoading(false);
  }, [sessionId, domain]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">Apply a domain specialisation profile to an active session.</p>
          <Input placeholder="Session ID" value={sessionId} onChange={e => setSessionId(e.target.value)} />
          <Input placeholder="Domain ID (e.g. legal, medical, coding)" value={domain} onChange={e => setDomain(e.target.value)} />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={apply} disabled={loading || !sessionId.trim() || !domain.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Applying…</> : <><Play className="w-4 h-4 mr-2" />Apply</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-4 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">{result.message ?? "Specialisation applied"}</p>
              <p className="text-xs text-muted-foreground mt-1">Domain: {result.domain}</p>
              {result.model && <p className="text-xs text-muted-foreground">Routed to: <code className="bg-muted px-1 rounded">{result.model}</code></p>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Specialisation() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Microscope className="w-6 h-6 text-fuchsia-500" />
          Specialisation
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Detect domain expertise and route to specialised models automatically
        </p>
      </div>
      <Tabs defaultValue="domains">
        <TabsList>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="detect"><Search className="w-4 h-4 mr-1" />Detect</TabsTrigger>
          <TabsTrigger value="apply"><Play className="w-4 h-4 mr-1" />Apply</TabsTrigger>
        </TabsList>
        <TabsContent value="domains" className="mt-4"><DomainsTab /></TabsContent>
        <TabsContent value="detect" className="mt-4"><DetectTab /></TabsContent>
        <TabsContent value="apply" className="mt-4"><ApplyTab /></TabsContent>
      </Tabs>
    </div>
  );
}
