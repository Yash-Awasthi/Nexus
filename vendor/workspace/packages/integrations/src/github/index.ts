import { Octokit } from '@octokit/rest';

let _octokit: Octokit | null = null;

export function github(): Octokit {
  if (!_octokit) {
    const token = process.env['GITHUB_TOKEN'];
    if (!token) throw new Error('GITHUB_TOKEN not set');
    _octokit = new Octokit({ auth: token });
  }
  return _octokit;
}

// ── Issues ──────────────────────────────────────────────────────────────────
export async function createIssue(
  owner: string, repo: string, title: string, body?: string, labels?: string[],
): Promise<{ number: number; url: string }> {
  const res = await github().issues.create({ owner, repo, title, body, labels });
  return { number: res.data.number, url: res.data.html_url };
}

export async function listIssues(
  owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open',
): Promise<Array<{ number: number; title: string; url: string; labels: string[] }>> {
  const res = await github().issues.listForRepo({ owner, repo, state, per_page: 50 });
  return res.data.map((i) => ({
    number: i.number,
    title:  i.title,
    url:    i.html_url,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
  }));
}

export async function closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
  await github().issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
}

export async function createComment(
  owner: string, repo: string, issueNumber: number, body: string,
): Promise<void> {
  await github().issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

// ── PRs ──────────────────────────────────────────────────────────────────────
export async function createPR(
  owner: string, repo: string,
  title: string, head: string, base: string, body?: string,
): Promise<{ number: number; url: string }> {
  const res = await github().pulls.create({ owner, repo, title, head, base, body });
  return { number: res.data.number, url: res.data.html_url };
}

export async function listPRs(
  owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open',
): Promise<Array<{ number: number; title: string; url: string; state: string }>> {
  const res = await github().pulls.list({ owner, repo, state, per_page: 30 });
  return res.data.map((p) => ({
    number: p.number,
    title:  p.title,
    url:    p.html_url,
    state:  p.state,
  }));
}

export async function mergePR(
  owner: string, repo: string, prNumber: number, commitTitle?: string,
): Promise<void> {
  await github().pulls.merge({
    owner, repo, pull_number: prNumber, commit_title: commitTitle,
  });
}

// ── Repos ────────────────────────────────────────────────────────────────────
export async function listRepos(
  org?: string,
): Promise<Array<{ name: string; url: string; private: boolean }>> {
  const res = org
    ? await github().repos.listForOrg({ org, per_page: 50 })
    : await github().repos.listForAuthenticatedUser({ per_page: 50 });
  return res.data.map((r) => ({
    name:    r.name,
    url:     r.html_url,
    private: r.private,
  }));
}

export async function getRepoContents(
  owner: string, repo: string, path = '',
): Promise<Array<{ name: string; type: string; path: string }>> {
  const res = await github().repos.getContent({ owner, repo, path });
  const data = Array.isArray(res.data) ? res.data : [res.data];
  return data.map((f) => ({
    name: 'name' in f ? f.name : '',
    type: 'type' in f ? f.type : '',
    path: 'path' in f ? f.path : '',
  }));
}

// ── Actions ──────────────────────────────────────────────────────────────────
export async function triggerWorkflow(
  owner: string, repo: string, workflowId: string, ref: string,
  inputs?: Record<string, string>,
): Promise<void> {
  await github().actions.createWorkflowDispatch({
    owner, repo, workflow_id: workflowId, ref, inputs,
  });
}

export async function listWorkflowRuns(
  owner: string, repo: string, workflowId?: string,
): Promise<Array<{ id: number; status: string; conclusion: string | null; url: string }>> {
  const res = workflowId
    ? await github().actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, per_page: 10 })
    : await github().actions.listWorkflowRunsForRepo({ owner, repo, per_page: 10 });
  return res.data.workflow_runs.map((r) => ({
    id:         r.id,
    status:     r.status ?? '',
    conclusion: r.conclusion ?? null,
    url:        r.html_url,
  }));
}
