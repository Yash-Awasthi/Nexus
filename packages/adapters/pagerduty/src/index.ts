// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-pagerduty — PagerDuty adapter (Events API v2 + REST API)
 *
 * Capabilities: monitoring.alert, monitoring.log
 * Task types:
 *   pagerduty.trigger-incident  — trigger an alert (Events API v2)
 *   pagerduty.resolve-incident  — resolve a previously-triggered alert
 *   pagerduty.acknowledge       — acknowledge a triggered alert
 *   pagerduty.list-incidents    — list incidents (REST API)
 *
 * Auth:
 *   PAGERDUTY_ROUTING_KEY — integration/routing key for the Events API (trigger/resolve/ack)
 *   PAGERDUTY_API_KEY     — REST API token (list-incidents)
 * Base URL overrides: PAGERDUTY_EVENTS_URL, PAGERDUTY_API_URL
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

// ── Task input / output types ─────────────────────────────────────────────────

export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

export interface PagerDutyTriggerTask {
  taskType: "pagerduty.trigger-incident";
  summary: string;
  source: string;
  severity: PagerDutySeverity;
  /** Stable key to dedupe / later resolve this alert. Generated if omitted. */
  dedup_key?: string;
  component?: string;
  customDetails?: Record<string, unknown>;
}

export interface PagerDutyResolveTask {
  taskType: "pagerduty.resolve-incident";
  dedup_key: string;
}

export interface PagerDutyAcknowledgeTask {
  taskType: "pagerduty.acknowledge";
  dedup_key: string;
}

export interface PagerDutyListIncidentsTask {
  taskType: "pagerduty.list-incidents";
  statuses?: ("triggered" | "acknowledged" | "resolved")[];
  limit?: number;
}

export type PagerDutyTask =
  | PagerDutyTriggerTask
  | PagerDutyResolveTask
  | PagerDutyAcknowledgeTask
  | PagerDutyListIncidentsTask;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assertOk(res: Response): Promise<unknown> {
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-pagerduty", res.status, await res.text());
  }
  return res.json();
}

function enqueueEvent(
  eventsUrl: string,
  routingKey: string,
  action: "trigger" | "resolve" | "acknowledge",
  dedupKey: string | undefined,
  payload?: Record<string, unknown>,
): Promise<Response> {
  const body: Record<string, unknown> = {
    routing_key: routingKey,
    event_action: action,
    ...(dedupKey ? { dedup_key: dedupKey } : {}),
    ...(payload ? { payload } : {}),
  };
  return fetch(`${eventsUrl}/v2/enqueue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Execute ───────────────────────────────────────────────────────────────────

async function execute(task: PagerDutyTask, ctx: IExecutionContext): Promise<unknown> {
  const eventsUrl =
    (ctx.environment?.["PAGERDUTY_EVENTS_URL"] as string | undefined) ??
    "https://events.pagerduty.com";
  const apiUrl =
    (ctx.environment?.["PAGERDUTY_API_URL"] as string | undefined) ?? "https://api.pagerduty.com";

  switch (task.taskType) {
    case "pagerduty.trigger-incident": {
      const routingKey = requireEnv(ctx, "PAGERDUTY_ROUTING_KEY");
      ctx.logger.info("pagerduty.trigger-incident", {
        summary: task.summary,
        severity: task.severity,
      });
      const res = await enqueueEvent(eventsUrl, routingKey, "trigger", task.dedup_key, {
        summary: task.summary,
        source: task.source,
        severity: task.severity,
        component: task.component,
        custom_details: task.customDetails,
      });
      return assertOk(res);
    }

    case "pagerduty.resolve-incident": {
      const routingKey = requireEnv(ctx, "PAGERDUTY_ROUTING_KEY");
      ctx.logger.info("pagerduty.resolve-incident", { dedup_key: task.dedup_key });
      const res = await enqueueEvent(eventsUrl, routingKey, "resolve", task.dedup_key);
      return assertOk(res);
    }

    case "pagerduty.acknowledge": {
      const routingKey = requireEnv(ctx, "PAGERDUTY_ROUTING_KEY");
      ctx.logger.info("pagerduty.acknowledge", { dedup_key: task.dedup_key });
      const res = await enqueueEvent(eventsUrl, routingKey, "acknowledge", task.dedup_key);
      return assertOk(res);
    }

    case "pagerduty.list-incidents": {
      const apiKey = requireEnv(ctx, "PAGERDUTY_API_KEY");
      ctx.logger.info("pagerduty.list-incidents", { statuses: task.statuses });
      const params = new URLSearchParams({ limit: String(task.limit ?? 25) });
      for (const s of task.statuses ?? []) params.append("statuses[]", s);
      const res = await fetch(`${apiUrl}/incidents?${params}`, {
        method: "GET",
        headers: {
          Authorization: `Token token=${apiKey}`,
          Accept: "application/vnd.pagerduty+json;version=2",
        },
      });
      return assertOk(res);
    }

    default: {
      const exhaustive: never = task;
      throw new Error(`Unhandled PagerDuty task type: ${(exhaustive as PagerDutyTask).taskType}`);
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const pagerdutyAdapter = defineAdapter<PagerDutyTask>({
  name: "nexus-adapter-pagerduty",
  version: "0.1.0",
  capabilities: ["monitoring.alert", "monitoring.log"],
  taskTypes: [
    "pagerduty.trigger-incident",
    "pagerduty.resolve-incident",
    "pagerduty.acknowledge",
    "pagerduty.list-incidents",
  ],
  execute,
});

export default pagerdutyAdapter;
