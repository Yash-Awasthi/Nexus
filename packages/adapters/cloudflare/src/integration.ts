// SPDX-License-Identifier: Apache-2.0
// Cloudflare REST API wrapper (official SDK)
async function cfFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  const email = process.env["CLOUDFLARE_EMAIL"];
  const key = process.env["CLOUDFLARE_GLOBAL_API_KEY"];
  if (!token && !(email && key))
    throw new Error("CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL+CLOUDFLARE_GLOBAL_API_KEY not set");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  else {
    headers["X-Auth-Email"] = email!;
    headers["X-Auth-Key"] = key!;
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...opts,
    headers: Object.assign({}, headers, opts.headers as Record<string, string>),
  });
  const data = (await res.json()) as { success: boolean; result: unknown; errors: unknown[] };
  if (!data.success) throw new Error(`Cloudflare error: ${JSON.stringify(data.errors)}`);
  return data.result;
}

const ACCOUNT_ID = () => {
  const id = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID not set");
  return id;
};

export async function listZones(): Promise<{ id: string; name: string; status: string }[]> {
  const res = (await cfFetch("/zones?per_page=50")) as {
    id: string;
    name: string;
    status: string;
  }[];
  return res;
}

export async function listDnsRecords(
  zoneId: string,
): Promise<{ id: string; type: string; name: string; content: string }[]> {
  return cfFetch(`/zones/${zoneId}/dns_records?per_page=100`) as Promise<
    { id: string; type: string; name: string; content: string }[]
  >;
}

export async function createDnsRecord(
  zoneId: string,
  type: string,
  name: string,
  content: string,
  ttl = 1,
): Promise<{ id: string }> {
  return cfFetch(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type, name, content, ttl }),
  }) as Promise<{ id: string }>;
}

export async function listWorkers(): Promise<{ id: string; etag: string }[]> {
  return cfFetch(`/accounts/${ACCOUNT_ID()}/workers/scripts`) as Promise<
    { id: string; etag: string }[]
  >;
}

export async function deployWorker(name: string, script: string): Promise<void> {
  await cfFetch(`/accounts/${ACCOUNT_ID()}/workers/scripts/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/javascript" } as Record<string, string>,
    body: script,
  });
}

export async function purgeCache(zoneId: string, urls?: string[]): Promise<void> {
  await cfFetch(`/zones/${zoneId}/purge_cache`, {
    method: "POST",
    body: JSON.stringify(urls ? { files: urls } : { purge_everything: true }),
  });
}
