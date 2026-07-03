// SPDX-License-Identifier: Apache-2.0
/**
 * Token Conservation — compress prompts and monitor token usage efficiency.
 *
 * Tab 1: Compress — run a prompt through the compressor
 * Tab 2: Status — view compression statistics and savings
 *
 * API:
 *   POST /api/token-conservation/compress
 *   GET  /api/token-conservation/status
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Loader2, Minimize2, BarChart2, RefreshCw, Zap } from "lucide-react";

interface CompressResult {
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  savings: number;
  ratio?: number;
}

interface ConservationStatus {
  totalCompressed: number;
  totalTokensSaved: number;
  avgRatio?: number;
  estimatedCostSaved?: number;
  currency?: string;
}

export default function TokenConservation() {
  // Compress tab
  const [prompt, setPrompt] = useState("");
  const [aggressiveness, setAggressiveness] = useState(0.5);
  const [compressing, setCompressing] = useState(false);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [compressErr, setCompressErr] = useState("");

  // Status tab
  const [status, setStatus] = useState<ConservationStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    const r = await fetch("/api/token-conservation/status").catch(() => null);
    if (r?.ok) setStatus(await r.json());
    setLoadingStatus(false);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const compress = useCallback(async () => {
    if (!prompt.trim()) return;
    setCompressing(true);
    setCompressErr("");
    setResult(null);
    const r = await fetch("/api/token-conservation/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim(), aggressiveness }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setCompressErr("Compression failed");
    setCompressing(false);
  }, [prompt, aggressiveness]);

  const savingsPct = result ? Math.round((result.savings / result.originalTokens) * 100) : 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Minimize2 className="w-6 h-6 text-emerald-500" />
            Token Conservation
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Compress prompts and track token savings to reduce cost and latency
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadStatus}>
          <RefreshCw className={`w-4 h-4 ${loadingStatus ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <Tabs defaultValue="compress">
        <TabsList>
          <TabsTrigger value="compress">
            <Minimize2 className="w-4 h-4 mr-1" />
            Compress
          </TabsTrigger>
          <TabsTrigger value="status">
            <BarChart2 className="w-4 h-4 mr-1" />
            Status
          </TabsTrigger>
        </TabsList>

        {/* Compress */}
        <TabsContent value="compress" className="mt-4 space-y-4">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <Textarea
                rows={5}
                placeholder="Enter a prompt to compress…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="resize-none"
              />
              <div className="space-y-1">
                <label className="text-sm font-medium flex justify-between">
                  Aggressiveness
                  <span className="font-normal text-muted-foreground">
                    {Math.round(aggressiveness * 100)}%
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={aggressiveness}
                  onChange={(e) => setAggressiveness(parseFloat(e.target.value))}
                  className="w-full accent-primary"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Conservative</span>
                  <span>Aggressive</span>
                </div>
              </div>
              {compressErr && <p className="text-red-500 text-xs">{compressErr}</p>}
              <Button onClick={compress} disabled={compressing || !prompt.trim()}>
                {compressing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Compressing…
                  </>
                ) : (
                  <>
                    <Minimize2 className="w-4 h-4 mr-2" />
                    Compress
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {result && (
            <div className="space-y-3">
              {/* Stats bar */}
              <div className="grid grid-cols-3 gap-3">
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Original</p>
                    <p className="text-xl font-bold">{result.originalTokens}</p>
                    <p className="text-xs text-muted-foreground">tokens</p>
                  </CardContent>
                </Card>
                <Card className="border-emerald-200 dark:border-emerald-800">
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      Compressed
                    </p>
                    <p className="text-xl font-bold text-emerald-600">{result.compressedTokens}</p>
                    <p className="text-xs text-muted-foreground">tokens</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Saved</p>
                    <p className="text-xl font-bold">{savingsPct}%</p>
                    <p className="text-xs text-muted-foreground">{result.savings} tokens</p>
                  </CardContent>
                </Card>
              </div>
              {/* Progress bar */}
              <Card>
                <CardContent className="pt-3 pb-3">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Token usage after compression</span>
                    <span>{100 - savingsPct}% of original</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className="bg-emerald-500 h-2 rounded-full"
                      style={{ width: `${100 - savingsPct}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
              {/* Side-by-side */}
              <div className="grid md:grid-cols-2 gap-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-muted-foreground">Original</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {result.original}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border-primary/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs">Compressed</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{result.compressed}</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Status */}
        <TabsContent value="status" className="mt-4">
          {loadingStatus ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading status…
            </div>
          ) : !status ? (
            <Card>
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                No conservation data yet
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    Compressions Run
                  </p>
                  <p className="text-2xl font-bold">{status.totalCompressed.toLocaleString()}</p>
                </CardContent>
              </Card>
              <Card className="border-emerald-200 dark:border-emerald-800">
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Zap className="w-3 h-3" />
                    Tokens Saved
                  </p>
                  <p className="text-2xl font-bold text-emerald-600">
                    {status.totalTokensSaved.toLocaleString()}
                  </p>
                </CardContent>
              </Card>
              {status.avgRatio !== undefined && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Avg Ratio
                    </p>
                    <p className="text-2xl font-bold">{(status.avgRatio * 100).toFixed(1)}%</p>
                  </CardContent>
                </Card>
              )}
              {status.estimatedCostSaved !== undefined && (
                <Card className="col-span-2 md:col-span-1">
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Est. Cost Saved
                    </p>
                    <p className="text-2xl font-bold">
                      {status.currency ?? "$"}
                      {status.estimatedCostSaved.toFixed(2)}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
