// SPDX-License-Identifier: Apache-2.0
/**
 * Standard Answers — curated canonical Q&A pairs.
 *
 * When the council receives a matching query, the standard answer is
 * returned directly without hitting the LLM — consistent, instant, zero cost.
 *
 * API:
 *   GET    /api/standard-answers         — list
 *   POST   /api/standard-answers         — create
 *   PUT    /api/standard-answers/:id     — update
 *   DELETE /api/standard-answers/:id     — delete
 *   POST   /api/standard-answers/match   — test match against a query
 */
import {
  BookOpenCheck,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  RefreshCw,
  Search,
  CheckCircle,
  XCircle,
  Zap,
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
import { Textarea } from "~/components/ui/textarea";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StandardAnswer {
  id: string;
  question: string;
  answer: string;
  tags?: string[];
  enabled: boolean;
  matchCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface MatchResult {
  matched: boolean;
  answer?: StandardAnswer;
  score?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StandardAnswers() {
  const [answers, setAnswers] = useState<StandardAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<StandardAnswer | null>(null);
  const [form, setForm] = useState({ question: "", answer: "", tags: "" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Match test
  const [testQuery, setTestQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);

  const [err, setErr] = useState("");

  const loadAnswers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/standard-answers");
      if (r.ok) {
        setAnswers((await r.json()) as StandardAnswer[]);
      }
    } catch {
      /* the list stays as it was */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAnswers();
  }, [loadAnswers]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setForm({ question: "", answer: "", tags: "" });
    setShowForm(true);
  }, []);

  const openEdit = useCallback((a: StandardAnswer) => {
    setEditing(a);
    setForm({ question: a.question, answer: a.answer, tags: (a.tags ?? []).join(", ") });
    setShowForm(true);
  }, []);

  const saveAnswer = useCallback(async () => {
    if (!form.question.trim() || !form.answer.trim()) {
      setErr("Question and answer are required");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const body = {
        question: form.question.trim(),
        answer: form.answer.trim(),
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
      let r: Response;
      if (editing) {
        r = await fetch(`/api/standard-answers/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch("/api/standard-answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setErr(d.message ?? d.error ?? "Save failed");
        return;
      }
      setShowForm(false);
      loadAnswers();
    } catch {
      setErr("Save failed");
    } finally {
      setSaving(false);
    }
  }, [form, editing, loadAnswers]);

  const deleteAnswer = useCallback(async (id: string) => {
    if (!confirm("Delete this standard answer?")) return;
    setDeleting(id);
    try {
      const r = await fetch(`/api/standard-answers/${id}`, { method: "DELETE" });
      if (r.ok) setAnswers((prev) => prev.filter((a) => a.id !== id));
    } catch {
      /* the answer stays listed */
    }
    setDeleting(null);
  }, []);

  const testMatch = useCallback(async () => {
    if (!testQuery.trim()) return;
    setTesting(true);
    setMatchResult(null);
    try {
      const r = await fetch("/api/standard-answers/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: testQuery.trim() }),
      });
      if (r.ok) setMatchResult((await r.json()) as MatchResult);
    } catch {
      /* no match shown */
    }
    setTesting(false);
  }, [testQuery]);

  const filtered = answers.filter(
    (a) =>
      a.question.toLowerCase().includes(searchFilter.toLowerCase()) ||
      a.answer.toLowerCase().includes(searchFilter.toLowerCase()) ||
      (a.tags ?? []).some((t) => t.toLowerCase().includes(searchFilter.toLowerCase())),
  );

  return (
    <Page width="default">
      <PageHeader
        title="Curated answers"
        description="Answers you've approved. When a question matches one, the council is handed it as the reference to build on."
        actions={
          <>
            <Button variant="ghost" size="icon-sm" onClick={loadAnswers} aria-label="Refresh">
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
            <Button onClick={openCreate}>
              <Plus /> New answer
            </Button>
          </>
        }
      />

      {/* Match tester */}
      <Card className="bg-primary/10 border-primary/30">
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm font-medium flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            Test match
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Enter a query to check if it matches a standard answer…"
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && testMatch()}
              className="flex-1"
            />
            <Button onClick={testMatch} disabled={testing || !testQuery.trim()} variant="outline">
              {testing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
            </Button>
          </div>
          {matchResult && (
            <div
              className={`p-3 rounded-lg text-sm ${
                matchResult.matched ? "bg-success/10  border border-success/30 " : "bg-muted"
              }`}
            >
              {matchResult.matched ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span className="font-medium text-success">
                      Matched! (score: {matchResult.score?.toFixed(2) ?? "—"})
                    </span>
                  </div>
                  <p className="font-medium text-xs mb-1">{matchResult.answer?.question}</p>
                  <p className="text-xs text-muted-foreground">{matchResult.answer?.answer}</p>
                </>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <XCircle className="w-4 h-4" />
                  No match — query will be sent to the LLM
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Search */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Filter answers…"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground">
          {filtered.length} of {answers.length}
        </span>
      </div>

      {/* Answer list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-8 pb-8 text-center space-y-3">
            <BookOpenCheck className="w-12 h-12 mx-auto text-muted-foreground opacity-40" />
            <p className="text-muted-foreground">
              {searchFilter ? `No answers match "${searchFilter}"` : "No standard answers yet"}
            </p>
            {!searchFilter && (
              <Button size="sm" onClick={openCreate}>
                Add first answer
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => (
            <Card key={a.id} className={!a.enabled ? "opacity-60" : ""}>
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2 mb-1">
                      <p className="text-sm font-medium flex-1">{a.question}</p>
                      {a.matchCount !== undefined && a.matchCount > 0 && (
                        <Badge variant="outline" className="text-xs shrink-0">
                          {a.matchCount} hits
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-2">{a.answer}</p>
                    {(a.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {a.tags!.map((t) => (
                          <Badge key={t} variant="secondary" className="text-xs font-normal">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEdit(a)}
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:bg-destructive/10"
                      onClick={() => deleteAnswer(a.id)}
                      disabled={deleting === a.id}
                    >
                      {deleting === a.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Trash2 className="w-3 h-3" />
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Answer" : "New Standard Answer"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Question *</label>
              <Input
                placeholder="What is the refund policy?"
                value={form.question}
                onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Answer *</label>
              <Textarea
                placeholder="We offer a 30-day refund policy…"
                value={form.answer}
                onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
                rows={5}
                className="resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Tags</label>
              <Input
                placeholder="billing, refund, policy (comma-separated)"
                value={form.tags}
                onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              />
            </div>
            {err && <p className="text-destructive text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button onClick={saveAnswer} disabled={saving || !form.question || !form.answer}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
