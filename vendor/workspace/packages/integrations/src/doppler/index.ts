// Doppler Secrets API wrapper
async function dopplerFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const token = process.env['DOPPLER_TOKEN'];
  if (!token) throw new Error('DOPPLER_TOKEN not set');
  const res = await fetch(`https://api.doppler.com/v3${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers as Record<string, string>,
    },
  });
  if (!res.ok) throw new Error(`Doppler error: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function listProjects(): Promise<Array<{ id: string; name: string }>> {
  const data = await dopplerFetch('/projects') as { projects: Array<{ id: string; name: string }> };
  return data.projects;
}

export async function listSecrets(
  project: string, config: string,
): Promise<string[]> {
  const data = await dopplerFetch(`/configs/config/secrets/names?project=${project}&config=${config}`) as {
    names: string[];
  };
  return data.names;
}

export async function getSecret(
  project: string, config: string, name: string,
): Promise<string> {
  const data = await dopplerFetch(
    `/configs/config/secret?project=${project}&config=${config}&name=${name}`,
  ) as { value: { raw: string } };
  return data.value.raw;
}

export async function setSecret(
  project: string, config: string, name: string, value: string,
): Promise<void> {
  await dopplerFetch(`/configs/config/secrets`, {
    method: 'POST',
    body:   JSON.stringify({ project, config, secrets: { [name]: value } }),
  });
}

export async function deleteSecret(
  project: string, config: string, name: string,
): Promise<void> {
  await dopplerFetch(
    `/configs/config/secret?project=${project}&config=${config}&name=${name}`,
    { method: 'DELETE' },
  );
}

export async function downloadSecrets(
  project: string, config: string,
): Promise<Record<string, string>> {
  const data = await dopplerFetch(
    `/configs/config/secrets/download?project=${project}&config=${config}&format=json`,
  ) as Record<string, string>;
  return data;
}
