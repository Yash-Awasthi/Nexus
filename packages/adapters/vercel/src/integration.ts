// SPDX-License-Identifier: Apache-2.0
// Vercel REST API wrapper
async function vercelFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const token = process.env["VERCEL_TOKEN"];
  if (!token) throw new Error("VERCEL_TOKEN not set");
  const res = await fetch(`https://api.vercel.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string>),
    },
  });
  if (!res.ok) throw new Error(`Vercel API error: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function listProjects(): Promise<{ id: string; name: string; url: string }[]> {
  const data = (await vercelFetch("/v9/projects?limit=50")) as {
    projects: { id: string; name: string; link?: { deployHooks?: unknown[] } }[];
  };
  return data.projects.map((p) => ({
    id: p.id,
    name: p.name,
    url: `https://${p.name}.vercel.app`,
  }));
}

export async function listDeployments(
  projectId?: string,
): Promise<{ uid: string; url: string; state: string; created: number }[]> {
  const query = projectId ? `?projectId=${projectId}&limit=10` : "?limit=10";
  const data = (await vercelFetch(`/v6/deployments${query}`)) as {
    deployments: { uid: string; url: string; state: string; created: number }[];
  };
  return data.deployments;
}

export async function getDeployment(deploymentId: string): Promise<{
  uid: string;
  url: string;
  state: string;
  target: string | null;
}> {
  return vercelFetch(`/v13/deployments/${deploymentId}`) as Promise<{
    uid: string;
    url: string;
    state: string;
    target: string | null;
  }>;
}

export async function cancelDeployment(deploymentId: string): Promise<void> {
  await vercelFetch(`/v12/deployments/${deploymentId}/cancel`, { method: "PATCH" });
}

export async function listEnvVars(
  projectId: string,
): Promise<{ id: string; key: string; target: string[] }[]> {
  const data = (await vercelFetch(`/v9/projects/${projectId}/env`)) as {
    envs: { id: string; key: string; target: string[] }[];
  };
  return data.envs;
}

export async function setEnvVar(
  projectId: string,
  key: string,
  value: string,
  target: string[] = ["production", "preview", "development"],
): Promise<void> {
  await vercelFetch(`/v10/projects/${projectId}/env`, {
    method: "POST",
    body: JSON.stringify({ key, value, type: "encrypted", target }),
  });
}
