// SPDX-License-Identifier: Apache-2.0
import { FileCode, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { apiFetch } from "~/lib/api";

interface SavedSpec {
  id: string;
  name: string;
  tools: string[];
  url: string;
}

/** Any REST API with an OpenAPI spec, served as an MCP endpoint whose tools are its operations. */
export function OpenApiTools() {
  const [specs, setSpecs] = useState<SavedSpec[]>([]);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      apiFetch<{ specs: SavedSpec[] }>("/api/v1/mcp/openapi")
        .then((d) => setSpecs(d.specs))
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError("");
    const text = source.trim();
    let spec: unknown;
    if (!/^https?:\/\//.test(text)) {
      try {
        spec = JSON.parse(text);
      } catch {
        setError("Give a spec URL, or paste the spec as JSON.");
        setBusy(false);
        return;
      }
    }
    try {
      await apiFetch("/api/v1/mcp/openapi", {
        method: "POST",
        json: {
          name: name.trim(),
          ...(spec ? { spec } : { specUrl: text }),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(authorization.trim() ? { authorization: authorization.trim() } : {}),
        },
      });
      setName("");
      setSource("");
      setBaseUrl("");
      setAuthorization("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string) =>
    apiFetch(`/api/v1/mcp/openapi/${id}`, { method: "DELETE" })
      .then(load)
      .catch((e: Error) => setError(e.message));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileCode className="size-4" /> REST APIs as MCP tools
        </CardTitle>
        <CardDescription>
          Save an OpenAPI spec and its operations become tools at an MCP endpoint, usable in agent
          runs and any MCP client.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {specs.map((s) => (
          <div key={s.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">{s.name}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${s.name}`}
                onClick={() => void remove(s.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <code className="block break-all text-xs text-muted-foreground">{s.url}</code>
            <div className="flex flex-wrap gap-1">
              {s.tools.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px] font-normal">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        ))}

        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="oa-name">Name</Label>
            <Input id="oa-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oa-spec">Spec URL or JSON</Label>
            <Textarea
              id="oa-spec"
              rows={3}
              placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oa-base">Base URL (when the spec names none)</Label>
            <Input id="oa-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oa-auth">Authorization header (optional, stored encrypted)</Label>
            <Input
              id="oa-auth"
              type="password"
              autoComplete="off"
              value={authorization}
              onChange={(e) => setAuthorization(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button onClick={() => void add()} disabled={busy || !name.trim() || !source.trim()}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Add API
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
