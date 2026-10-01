// SPDX-License-Identifier: Apache-2.0
/**
 * The owner's daily inbox: reviews waiting over an hour, blocked work, approvals
 * waiting over a day, and budgets past their warning share, across every company,
 * as one notification a day. Built from stored state alone, with no model call.
 */

import { createNotification } from "./notifications-store.js";
import { listApprovals } from "./org-approvals.js";
import { budgetOverview } from "./org-budget.js";
import { onTick } from "./org-scheduler.js";
import { allCompanies, listAgents, listCompanies, onOrgLoad } from "./org-store.js";
import { listTasks } from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";

const REVIEW_STALE_MS = 3600_000;
// A day unless the deployment says otherwise; end-to-end checks set 0 to see a fresh approval.
const approvalStaleMs = () => Number(process.env.NEXUS_ORG_APPROVAL_STALE_HOURS ?? 24) * 3600_000;

/** One thing waiting on the owner, with the id the inbox acts on. */
export interface InboxItem {
  kind: "review" | "blocked" | "approval" | "budget";
  text: string;
  taskId?: string;
  approvalId?: string;
}

export interface InboxDigest {
  companies: {
    companyId: string;
    name: string;
    items: InboxItem[];
    /** Who a waiting task can be handed to. */
    agents: { id: string; name: string }[];
  }[];
  total: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function inboxDigest(ownerId: string, at = new Date()): InboxDigest {
  const now = at.getTime();
  const approvalStale = approvalStaleMs();
  const companies = listCompanies(ownerId)
    .filter((c) => c.status !== "archived")
    .map((c) => {
      const items: InboxItem[] = [];
      for (const t of listTasks(ownerId, c.id, { status: "in_review,blocked" }))
        if (t.status === "blocked")
          items.push({
            kind: "blocked",
            taskId: t.id,
            text: `${t.identifier} is blocked: ${t.title}`,
          });
        else if (now - Date.parse(t.updatedAt) > REVIEW_STALE_MS)
          items.push({
            kind: "review",
            taskId: t.id,
            text: `${t.identifier} has waited for review since ${day(new Date(t.updatedAt))}: ${t.title}`,
          });
      for (const a of listApprovals(ownerId, c.id, "pending"))
        if (now - Date.parse(a.createdAt) >= approvalStale)
          items.push({
            kind: "approval",
            approvalId: a.id,
            text: `An approval has been waiting since ${day(new Date(a.createdAt))}: ${a.title}`,
          });
      for (const p of budgetOverview(ownerId, c.id).policies)
        if (p.state !== "ok")
          items.push({
            kind: "budget",
            text: `The ${p.windowKind} budget for ${p.scopeName} is at ${(p.observedMicros / 1e6).toFixed(2)} of ${(p.amountMicros / 1e6).toFixed(2)} USD`,
          });
      const agents = listAgents(ownerId, c.id)
        .filter((a) => a.status !== "terminated" && a.status !== "pending_approval")
        .map((a) => ({ id: a.id, name: a.name }));
      return { companyId: c.id, name: c.name, items, agents };
    })
    .filter((c) => c.items.length > 0);
  return { companies, total: companies.reduce((n, c) => n + c.items.length, 0) };
}

/** The day each owner last got a digest, keyed by owner id. */
const sent = new PersistentStore<{ id: string; day: string }>("org_inbox_sent");
onOrgLoad(() => sent.load());

/** Send today's digest to every owner who has something waiting and has not had one today. */
export async function sendInboxDigests(at = new Date(), only?: string): Promise<string[]> {
  const today = day(at);
  const owners = only ? [only] : [...new Set(allCompanies().map((c) => c.ownerId))];
  const done: string[] = [];
  for (const ownerId of owners) {
    if (!only && sent.get(ownerId)?.day === today) continue;
    const digest = inboxDigest(ownerId, at);
    if (digest.total === 0) continue;
    sent.set(ownerId, { id: ownerId, day: today });
    await createNotification(ownerId, {
      type: "org",
      title: `Your company inbox: ${digest.total} item${digest.total === 1 ? "" : "s"} waiting`,
      message: digest.companies
        .map((c) => `${c.name}\n${c.items.map((i) => `- ${i.text}`).join("\n")}`)
        .join("\n\n"),
      // Opens the inbox on the first company, where each item can be acted on.
      link: `/org?c=${digest.companies[0]!.companyId}&inbox=open`,
    });
    done.push(ownerId);
  }
  return done;
}

onTick((at) => void sendInboxDigests(at));
