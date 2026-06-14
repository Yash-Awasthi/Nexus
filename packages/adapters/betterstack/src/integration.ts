// SPDX-License-Identifier: Apache-2.0
// Better Stack (Logtail + Uptime) API wrapper
async function bsFetch(base: string, path: string, opts: RequestInit = {}): Promise<unknown> {
  const token = process.env["BETTER_STACK_API_TOKEN"];
  if (!token) throw new Error("BETTER_STACK_API_TOKEN not set");
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string>),
    },
  });
  if (!res.ok) throw new Error(`Better Stack error: ${res.status} ${await res.text()}`);
  return res.json();
}

const uptime = (path: string, opts?: RequestInit) =>
  bsFetch("https://uptime.betterstack.com/api/v2", path, opts);

export async function listMonitors(): Promise<
  {
    id: string;
    name: string;
    url: string;
    status: string;
    uptime: number;
  }[]
> {
  const data = (await uptime("/monitors")) as {
    data: {
      id: string;
      attributes: { pronounceable_name: string; url: string; status: string; uptime: number };
    }[];
  };
  return data.data.map((m) => ({
    id: m.id,
    name: m.attributes.pronounceable_name,
    url: m.attributes.url,
    status: m.attributes.status,
    uptime: m.attributes.uptime,
  }));
}

export async function getMonitor(id: string): Promise<{
  name: string;
  status: string;
  uptime: number;
  url: string;
}> {
  const data = (await uptime(`/monitors/${id}`)) as {
    data: {
      attributes: { pronounceable_name: string; status: string; uptime: number; url: string };
    };
  };
  return {
    name: data.data.attributes.pronounceable_name,
    status: data.data.attributes.status,
    uptime: data.data.attributes.uptime,
    url: data.data.attributes.url,
  };
}

export async function listIncidents(): Promise<
  {
    id: string;
    name: string;
    status: string;
    started: string;
  }[]
> {
  const data = (await uptime("/incidents?per_page=20")) as {
    data: { id: string; attributes: { name: string; status: string; started_at: string } }[];
  };
  return data.data.map((i) => ({
    id: i.id,
    name: i.attributes.name,
    status: i.attributes.status,
    started: i.attributes.started_at,
  }));
}

export async function createMonitor(
  name: string,
  url: string,
  checkFrequency = 180,
): Promise<{ id: string }> {
  const data = (await uptime("/monitors", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "monitor",
        attributes: { pronounceable_name: name, url, check_frequency: checkFrequency },
      },
    }),
  })) as { data: { id: string } };
  return { id: data.data.id };
}

export async function sendLog(
  message: string,
  level: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const sourceToken = process.env["BETTER_STACK_SOURCE_TOKEN"];
  if (!sourceToken) return; // non-fatal
  await fetch("https://in.logs.betterstack.com", {
    method: "POST",
    headers: { Authorization: `Bearer ${sourceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, level, ...meta }),
  });
}
