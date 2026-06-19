// SPDX-License-Identifier: Apache-2.0
import React, { useState, useCallback } from "react";
import { DiffBlock, type Hunk, type HunkLine } from "./DiffBlock";
import { DiffSessionToolbar } from "./DiffSessionToolbar";

interface DiffViewerProps {
  filename: string;
  original: string;
  modified: string;
  onApply?: (acceptedHunks: Hunk[]) => Promise<{ rollbackId?: string } | void>;
}

// ── Myers diff (line-level) ────────────────────────────────────────────────────

function myersDiff(
  a: string[],
  b: string[],
): Array<{ type: "equal" | "insert" | "delete"; value: string }> {
  const result: Array<{ type: "equal" | "insert" | "delete"; value: string }> = [];
  const n = a.length,
    m = b.length;
  const max = n + m;
  const v: Record<number, number> = { 1: 0 };
  const trace: (typeof v)[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push({ ...v });
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[k - 1] ?? 0) < (v[k + 1] ?? 0))
          ? (v[k + 1] ?? 0)
          : (v[k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k] = x;
      if (x >= n && y >= m) {
        // Backtrack
        let cx = x,
          cy = y;
        for (let bd = d; bd > 0; bd--) {
          const prev = trace[bd - 1];
          const pk = cx - cy;
          let prevX: number, prevY: number;
          if (pk === -bd || (pk !== bd && (prev[pk - 1] ?? 0) < (prev[pk + 1] ?? 0))) {
            prevX = prev[pk + 1] ?? 0;
            prevY = prevX - (pk + 1);
          } else {
            prevX = (prev[pk - 1] ?? 0) + 1;
            prevY = prevX - (pk - 1);
          }
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            result.unshift({ type: "equal", value: a[cx] });
          }
          if (cx > prevX) {
            cx--;
            result.unshift({ type: "delete", value: a[cx] });
          } else {
            cy--;
            result.unshift({ type: "insert", value: b[cy] });
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          result.unshift({ type: "equal", value: a[cx] });
        }
        return result;
      }
    }
  }
  return result;
}

function buildHunks(filename: string, original: string, modified: string): Hunk[] {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const diff = myersDiff(origLines, modLines);

  const hunks: Hunk[] = [];
  let oldLine = 1,
    newLine = 1;
  let currentHunk: Hunk | null = null;
  const CONTEXT = 3;

  // Collect changed regions with context
  const changes: Array<{ idx: number; type: "equal" | "insert" | "delete"; value: string }> =
    diff.map((d, i) => ({ idx: i, ...d }));

  const changed = changes.filter((c) => c.type !== "equal");
  if (changed.length === 0) return [];

  // Group into hunks by proximity
  const groups: Array<typeof changed> = [];
  let current: typeof changed = [changed[0]];
  for (let i = 1; i < changed.length; i++) {
    if (changed[i].idx - changed[i - 1].idx > CONTEXT * 2 + 1) {
      groups.push(current);
      current = [changed[i]];
    } else {
      current.push(changed[i]);
    }
  }
  groups.push(current);

  for (const group of groups) {
    const startIdx = Math.max(0, group[0].idx - CONTEXT);
    const endIdx = Math.min(diff.length - 1, group[group.length - 1].idx + CONTEXT);

    const lines: HunkLine[] = [];
    let lo = oldLine,
      ln = newLine;

    // Advance counters to startIdx
    for (let i = 0; i < startIdx; i++) {
      if (diff[i].type !== "insert") lo++;
      if (diff[i].type !== "delete") ln++;
    }

    const hunkOldStart = lo;
    const hunkNewStart = ln;

    for (let i = startIdx; i <= endIdx; i++) {
      const d = diff[i];
      if (d.type === "equal") {
        lines.push({ type: "context", content: d.value, oldLine: lo++, newLine: ln++ });
      } else if (d.type === "delete") {
        lines.push({ type: "removed", content: d.value, oldLine: lo++ });
      } else {
        lines.push({ type: "added", content: d.value, newLine: ln++ });
      }
    }

    hunks.push({
      id: `hunk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filename,
      oldStart: hunkOldStart,
      newStart: hunkNewStart,
      lines,
      status: "pending",
    });
  }

  return hunks;
}

export function DiffViewer({ filename, original, modified, onApply }: DiffViewerProps) {
  const [hunks, setHunks] = useState<Hunk[]>(() => buildHunks(filename, original, modified));
  const [rollbackId, setRollbackId] = useState<string | undefined>();
  const [isApplying, setIsApplying] = useState(false);

  const accepted = hunks.filter((h) => h.status === "accepted").length;
  const total = hunks.length;

  const handleAccept = useCallback((id: string) => {
    setHunks((prev) => prev.map((h) => (h.id === id ? { ...h, status: "accepted" } : h)));
  }, []);

  const handleReject = useCallback((id: string) => {
    setHunks((prev) => prev.map((h) => (h.id === id ? { ...h, status: "rejected" } : h)));
  }, []);

  const handleEdit = useCallback((id: string, editedLines: HunkLine[]) => {
    setHunks((prev) =>
      prev.map((h) => (h.id === id ? { ...h, lines: editedLines, status: "accepted" } : h)),
    );
  }, []);

  const handleApply = useCallback(async () => {
    if (!onApply) return;
    setIsApplying(true);
    try {
      const result = await onApply(hunks.filter((h) => h.status === "accepted"));
      if (result?.rollbackId) setRollbackId(result.rollbackId);
    } finally {
      setIsApplying(false);
    }
  }, [hunks, onApply]);

  const handleRejectAll = useCallback(() => {
    setHunks((prev) => prev.map((h) => ({ ...h, status: "rejected" })));
  }, []);

  const handleRollback = useCallback(async () => {
    if (!rollbackId) return;
    try {
      await fetch("/api/diff/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rollbackId }),
      });
      setRollbackId(undefined);
      setHunks((prev) => prev.map((h) => ({ ...h, status: "pending" })));
    } catch {}
  }, [rollbackId]);

  if (hunks.length === 0) {
    return (
      <div style={{ padding: 16, color: "#555", fontSize: 12, textAlign: "center" }}>
        No changes detected
      </div>
    );
  }

  return (
    <div>
      {hunks.map((hunk) => (
        <DiffBlock
          key={hunk.id}
          hunk={hunk}
          onAccept={handleAccept}
          onReject={handleReject}
          onEdit={handleEdit}
        />
      ))}
      <DiffSessionToolbar
        accepted={accepted}
        total={total}
        rollbackId={rollbackId}
        onApply={handleApply}
        onRejectAll={handleRejectAll}
        onRollback={handleRollback}
        isApplying={isApplying}
      />
    </div>
  );
}
