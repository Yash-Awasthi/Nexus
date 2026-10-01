// SPDX-License-Identifier: Apache-2.0
/** Which model your own council runs say suits a question. API: GET /api/v1/llm/learned-route */
import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { apiFetch } from "~/lib/api";

interface Routing {
  questions: number;
  needed: number;
  active: boolean;
  route?: { model: string; votes: Record<string, string> };
}

export function LearnedRouting() {
  const [state, setState] = useState<Routing | null>(null);
  const [query, setQuery] = useState("");

  const load = (q?: string) =>
    apiFetch<Routing>(`/api/v1/llm/learned-route${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then(setState)
      .catch(() => setState(null));

  useEffect(() => {
    void load();
  }, []);

  if (!state) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Learned routing</CardTitle>
        <CardDescription>
          {state.active
            ? `Trained on ${state.questions} of your council questions: which model held the council's position.`
            : `Learns from council questions where members agree. ${state.questions} of ${state.needed} collected; it switches on at ${state.needed}.`}
        </CardDescription>
      </CardHeader>
      {state.active && (
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) void load(query.trim());
            }}
          >
            <Input
              aria-label="Question to route"
              placeholder="A question you might ask…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="outline" aria-label="Route" disabled={!query.trim()}>
              <Search className="size-4" />
            </Button>
          </form>
          {state.route && (
            <div className="text-sm">
              <p>
                Best fit: <span className="font-mono break-all">{state.route.model}</span>
              </p>
              <p className="text-xs text-muted-foreground break-words">
                {Object.entries(state.route.votes)
                  .map(([router, model]) => `${router.toUpperCase()} ${model}`)
                  .join(" · ")}
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
