// SPDX-License-Identifier: Apache-2.0
/**
 * Feature flags — the instance's switches, read by the features they name.
 *
 * API:
 *   GET    /api/v1/feature-flags        — list flags with current values
 *   PATCH  /api/v1/feature-flags/:key   — override a value
 *   DELETE /api/v1/feature-flags/:key   — back to the default
 */
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { apiFetch } from "~/lib/api";

type FlagValue = boolean | string | number;

interface FeatureFlag {
  key: string;
  value: FlagValue;
  default: FlagValue;
  type: "boolean" | "string" | "number";
  description?: string;
  overridden: boolean;
}

export default function AdminFeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const loadFlags = useCallback(async () => {
    setLoading(true);
    try {
      setFlags((await apiFetch<{ flags: FeatureFlag[] }>("/api/v1/feature-flags")).flags);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load flags");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadFlags();
  }, [loadFlags]);

  const save = useCallback(async (key: string, value: FlagValue | null) => {
    setSaving(key);
    setErr("");
    try {
      const url = `/api/v1/feature-flags/${encodeURIComponent(key)}`;
      if (value === null) await apiFetch(url, { method: "DELETE" });
      else await apiFetch(url, { method: "PATCH", json: { value } });
      setFlags((await apiFetch<{ flags: FeatureFlag[] }>("/api/v1/feature-flags")).flags);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
    setSaving(null);
  }, []);

  return (
    <Page width="default">
      <PageHeader
        title="Feature flags"
        description="Instance-wide switches. Each one changes what the named feature does, for every account, without a restart."
        actions={
          <Button variant="ghost" size="icon-sm" onClick={loadFlags} aria-label="Refresh">
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        }
      />

      {err && <p className="text-sm text-destructive">{err}</p>}

      {loading && flags.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" />
          Loading flags…
        </div>
      ) : (
        <div className="space-y-3">
          {flags.map((flag) => (
            <Card key={flag.key}>
              <CardContent className="flex flex-wrap items-start gap-4 py-4">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-medium break-all">{flag.key}</code>
                    {flag.overridden && <Badge variant="secondary">changed</Badge>}
                  </div>
                  {flag.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{flag.description}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Default: <code>{String(flag.default)}</code>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {flag.type === "boolean" ? (
                    <Switch
                      checked={flag.value === true}
                      disabled={saving === flag.key}
                      onCheckedChange={(on) => save(flag.key, on)}
                      aria-label={flag.key}
                    />
                  ) : (
                    <FlagInput flag={flag} disabled={saving === flag.key} onSave={save} />
                  )}
                  {flag.overridden && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={saving === flag.key}
                      onClick={() => save(flag.key, null)}
                      aria-label={`Reset ${flag.key}`}
                    >
                      <RotateCcw />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}

function FlagInput({
  flag,
  disabled,
  onSave,
}: {
  flag: FeatureFlag;
  disabled: boolean;
  onSave: (key: string, value: FlagValue) => void;
}) {
  const [draft, setDraft] = useState(String(flag.value));
  useEffect(() => setDraft(String(flag.value)), [flag.value]);
  const parsed = flag.type === "number" ? Number(draft) : draft;
  const valid = flag.type !== "number" || (draft.trim() !== "" && Number.isFinite(parsed));
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(flag.key, parsed);
      }}
    >
      <Input
        type={flag.type === "number" ? "number" : "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-24"
        aria-label={flag.key}
      />
      <Button size="sm" type="submit" disabled={disabled || !valid || draft === String(flag.value)}>
        Save
      </Button>
    </form>
  );
}
