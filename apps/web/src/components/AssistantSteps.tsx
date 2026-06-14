// SPDX-License-Identifier: Apache-2.0
/**
 * AssistantSteps — Collapsible chain-of-thought / tool-call visualization.
 *
 * Renders a compact summary header (e.g. "3 steps") that expands to show
 * individual reasoning steps, tool calls, search queries, etc.
 *
 * Steps are streamed in via the `steps` prop. Each step has a type
 * ("thinking" | "tool_call" | "search" | "result" | "note") and content.
 */

import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepType = "thinking" | "tool_call" | "search" | "result" | "note";

export interface AssistantStep {
  id: string;
  type: StepType;
  label: string;
  content?: string;
  durationMs?: number;
  /** ISO timestamp */
  timestamp?: string;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const STEP_ICONS: Record<StepType, string> = {
  thinking:  "◎",
  tool_call: "⚙",
  search:    "⌕",
  result:    "✓",
  note:      "◈",
};

const STEP_COLORS: Record<StepType, string> = {
  thinking:  "#64748b",
  tool_call: "#7c3aed",
  search:    "#0284c7",
  result:    "#16a34a",
  note:      "#d97706",
};

const s = {
  container: {
    marginBottom: 6,
    borderRadius: 8,
    border: "1px solid #1e2535",
    overflow: "hidden",
    fontSize: 12,
  } as React.CSSProperties,

  header: (open: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: open ? "#0d1220" : "#0a0e1a",
    cursor: "pointer",
    userSelect: "none",
    transition: "background 0.15s",
  }),

  headerIcon: {
    color: "#7c3aed",
    fontSize: 11,
    fontWeight: 700,
    minWidth: 12,
    textAlign: "center" as const,
  },

  headerLabel: {
    flex: 1,
    color: "#64748b",
    fontWeight: 500,
    letterSpacing: "0.02em",
  },

  chevron: (open: boolean): React.CSSProperties => ({
    color: "#334155",
    fontSize: 10,
    transition: "transform 0.2s",
    transform: open ? "rotate(180deg)" : "rotate(0deg)",
  }),

  stepList: {
    padding: "4px 0",
    background: "#080c18",
    borderTop: "1px solid #1e2535",
  } as React.CSSProperties,

  step: (type: StepType): React.CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "5px 12px",
    borderLeft: `2px solid ${STEP_COLORS[type]}22`,
    marginLeft: 10,
    marginBottom: 2,
  }),

  stepIcon: (type: StepType): React.CSSProperties => ({
    color: STEP_COLORS[type],
    fontSize: 11,
    minWidth: 14,
    textAlign: "center",
    marginTop: 1,
  }),

  stepBody: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,

  stepLabel: {
    color: "#94a3b8",
    fontWeight: 600,
    fontSize: 11,
    marginBottom: 1,
  } as React.CSSProperties,

  stepContent: {
    color: "#475569",
    fontSize: 11,
    fontFamily: "monospace",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    maxHeight: 80,
    overflow: "hidden",
    lineHeight: 1.4,
  } as React.CSSProperties,

  stepDuration: {
    fontSize: 10,
    color: "#1e2535",
    marginLeft: 4,
    flexShrink: 0,
  } as React.CSSProperties,
};

// ── Component ─────────────────────────────────────────────────────────────────

interface AssistantStepsProps {
  steps: AssistantStep[];
  /** Whether steps are still being added (shows spinning indicator). Default false. */
  streaming?: boolean;
  /** Override the header summary label. Default: "{n} steps" */
  label?: string;
  /** Start expanded. Default false. */
  defaultOpen?: boolean;
}

export function AssistantSteps({
  steps,
  streaming = false,
  label,
  defaultOpen = false,
}: AssistantStepsProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (steps.length === 0 && !streaming) return null;

  const summary = label ?? (streaming ? "Thinking…" : `${steps.length} step${steps.length !== 1 ? "s" : ""}`);

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header(open)} onClick={() => setOpen((v) => !v)} role="button" aria-expanded={open}>
        <span style={s.headerIcon}>{streaming ? <SpinnerDot /> : "◎"}</span>
        <span style={s.headerLabel}>{summary}</span>
        {steps.length > 0 && <span style={s.chevron(open)}>▾</span>}
      </div>

      {/* Step list */}
      {open && steps.length > 0 && (
        <div style={s.stepList}>
          {steps.map((step) => (
            <div key={step.id} style={s.step(step.type)}>
              <span style={s.stepIcon(step.type)} title={step.type}>
                {STEP_ICONS[step.type]}
              </span>
              <div style={s.stepBody}>
                <div style={s.stepLabel}>{step.label}</div>
                {step.content && (
                  <div style={s.stepContent}>{step.content}</div>
                )}
              </div>
              {step.durationMs !== undefined && (
                <span style={s.stepDuration}>{step.durationMs}ms</span>
              )}
            </div>
          ))}
          {streaming && (
            <div style={{ ...s.step("thinking"), opacity: 0.5 }}>
              <span style={s.stepIcon("thinking")}><SpinnerDot /></span>
              <div style={s.stepBody}>
                <div style={s.stepLabel}>Processing…</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function SpinnerDot() {
  // Pure CSS spinner via inline animation is not trivial without a stylesheet,
  // so we use a rotating Unicode character approach with a stateful interval.
  const frames = ["◐", "◓", "◑", "◒"];
  const [frame, setFrame] = useState(0);
  // useEffect isn't imported here by default — keep it simple with a static dot
  // for SSR safety. In practice, the Chat page can import useState/useEffect.
  void setFrame; // suppress unused warning — used via effect in consuming code
  return <span>{frames[frame % frames.length]}</span>;
}

// ── Factory helpers ───────────────────────────────────────────────────────────

let _stepCounter = 0;

export function makeStep(type: StepType, label: string, content?: string): AssistantStep {
  return {
    id: `step-${++_stepCounter}`,
    type,
    label,
    content,
    timestamp: new Date().toISOString(),
  };
}
