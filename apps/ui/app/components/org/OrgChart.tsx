// SPDX-License-Identifier: Apache-2.0
import { Pause, Pencil, Play, Skull, Zap } from "lucide-react";

import { Button } from "~/components/ui/button";
import { ADAPTERS, StatusPill, timeAgo, type Agent, type OrgNode } from "~/lib/org";

interface AgentActions {
  onEdit: (a: Agent) => void;
  onStatus: (a: Agent, verb: "pause" | "resume" | "terminate") => void;
  onWake?: (a: Agent) => void;
  onOpen?: (a: Agent) => void;
  /** Hide the controls: the company is shared with the viewer read-only. */
  readOnly?: boolean;
}

function Node({ node, depth, actions }: { node: OrgNode; depth: number; actions: AgentActions }) {
  const a = node.agent;
  return (
    <li className="relative">
      <div
        className="group flex items-start gap-3 rounded-lg border bg-card p-3 shadow-xs"
        data-testid="org-node"
        data-agent-name={a.name}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {a.name.slice(0, 2).toUpperCase()}
        </div>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => actions.onOpen?.(a)}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{a.name}</span>
            <StatusPill status={a.status} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {a.title || a.role}
            {a.adapterType !== "nexus"
              ? ` · ${ADAPTERS.find((x) => x.id === a.adapterType)?.label ?? a.adapterType}`
              : ""}
            {a.model ? ` · ${a.model}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">Last run {timeAgo(a.lastHeartbeatAt)}</p>
        </button>
        <div className={`shrink-0 gap-1 ${actions.readOnly ? "hidden" : "flex"}`}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Edit ${a.name}`}
            onClick={() => actions.onEdit(a)}
          >
            <Pencil className="size-4" />
          </Button>
          {actions.onWake && (a.status === "idle" || a.status === "error") && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Run ${a.name} now`}
              onClick={() => actions.onWake?.(a)}
            >
              <Zap className="size-4" />
            </Button>
          )}
          {a.status === "paused" || a.status === "error" ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Resume ${a.name}`}
              onClick={() => actions.onStatus(a, "resume")}
            >
              <Play className="size-4" />
            </Button>
          ) : a.status === "idle" || a.status === "running" ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Pause ${a.name}`}
              onClick={() => actions.onStatus(a, "pause")}
            >
              <Pause className="size-4" />
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Terminate ${a.name}`}
            onClick={() => actions.onStatus(a, "terminate")}
          >
            <Skull className="size-4" />
          </Button>
        </div>
      </div>
      {node.reports.length > 0 && (
        <ul className="ml-4 mt-2 space-y-2 border-l pl-3 sm:ml-6 sm:pl-4">
          {node.reports.map((r) => (
            <Node key={r.agent.id} node={r} depth={depth + 1} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Vertical reporting tree; reads well at phone width and scales up unchanged. */
export function OrgChart({ roots, actions }: { roots: OrgNode[]; actions: AgentActions }) {
  if (roots.length === 0)
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No agents yet. Hire a CEO first, then build the team under it.
      </p>
    );
  return (
    <ul className="space-y-2" aria-label="Org chart">
      {roots.map((r) => (
        <Node key={r.agent.id} node={r} depth={0} actions={actions} />
      ))}
    </ul>
  );
}
