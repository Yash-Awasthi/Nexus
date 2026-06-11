// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
import { LinearClient } from "@linear/sdk";
export type { LinearDocument } from "@linear/sdk";

let _linear: LinearClient | null = null;

export function linear(): LinearClient {
  if (!_linear) {
    const key = process.env["LINEAR_API_KEY"];
    if (!key) throw new Error("LINEAR_API_KEY not set");
    _linear = new LinearClient({ apiKey: key });
  }
  return _linear;
}

export async function createIssue(
  title: string,
  description?: string,
  teamId?: string,
  priority?: number,
): Promise<{ id: string; url: string; identifier: string }> {
  const teams = teamId ? undefined : await linear().teams();
  const resolvedTeamId = teamId ?? teams?.nodes[0]?.id;
  if (!resolvedTeamId) throw new Error("No Linear team found");

  const res = await linear().createIssue({
    title,
    description,
    teamId: resolvedTeamId,
    priority: priority ?? 3,
  });
  const issue = await res.issue;
  if (!issue) throw new Error("Issue creation failed");
  return { id: issue.id, url: issue.url, identifier: issue.identifier };
}

export async function listIssues(
  teamId?: string,
  state?: string,
): Promise<{ id: string; title: string; state: string; priority: number; identifier: string }[]> {
  const filter: Record<string, unknown> = {};
  if (teamId) filter["team"] = { id: { eq: teamId } };
  if (state) filter["state"] = { name: { eq: state } };
  const issues = await linear().issues({ filter, first: 50 });
  return Promise.all(
    issues.nodes.map(async (i) => ({
      id: i.id,
      title: i.title,
      state: (await i.state)?.name ?? "unknown",
      priority: i.priority,
      identifier: i.identifier,
    })),
  );
}

export async function updateIssue(
  id: string,
  updates: { title?: string; description?: string; priority?: number; stateId?: string },
): Promise<void> {
  await linear().updateIssue(id, updates);
}

export async function listTeams(): Promise<{ id: string; name: string; key: string }[]> {
  const teams = await linear().teams();
  return teams.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key }));
}

export async function listCycles(
  teamId: string,
): Promise<{ id: string; number: number; name: string | undefined; startsAt: Date }[]> {
  const team = await linear().team(teamId);
  const cycles = await team.cycles();
  return cycles.nodes.map((c) => ({
    id: c.id,
    number: c.number,
    name: c.name,
    startsAt: c.startsAt,
  }));
}
