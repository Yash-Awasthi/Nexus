// SPDX-License-Identifier: Apache-2.0
/** How each model's council answers read over time, and which ones just changed. API: GET /api/v1/stm/drift */
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { apiFetch } from "~/lib/api";

interface Snapshot {
  mean: number;
  latest: number | null;
}

interface ModelDrift {
  model: string;
  answers: number;
  metrics: Record<"hedgeDensity" | "verbosityRatio" | "wordCount", Snapshot>;
  drifting: string[];
}

const LABELS = {
  hedgeDensity: "Hedges / 100 words",
  verbosityRatio: "Words / sentence",
  wordCount: "Words",
} as const;

const n = (v: number | null) => (v === null ? "—" : v >= 100 ? Math.round(v) : v.toFixed(1));

export function AnswerDrift() {
  const [models, setModels] = useState<ModelDrift[] | null>(null);

  useEffect(() => {
    apiFetch<{ models: ModelDrift[] }>("/api/v1/stm/drift")
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);

  if (!models?.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Answer style by model</CardTitle>
        <CardDescription>
          From your recent council answers: the average, then the latest answer. Drift means the
          latest is far from that model&apos;s usual.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {models.map((m) => (
          <div key={m.model} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm break-all">{m.model}</span>
              <span className="text-xs text-muted-foreground">{m.answers} answers</span>
              {m.drifting.length > 0 && <Badge variant="destructive">drift</Badge>}
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((k) => (
                <div key={k} className={m.drifting.includes(k) ? "text-destructive" : ""}>
                  <p className="text-muted-foreground">{LABELS[k]}</p>
                  <p className="tabular-nums">
                    {n(m.metrics[k].mean)} → {n(m.metrics[k].latest)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
