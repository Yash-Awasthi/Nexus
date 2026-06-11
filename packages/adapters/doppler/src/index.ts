// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-doppler
 *
 * Secrets management via the Doppler REST API.
 * Task types: doppler.get-secret, doppler.list-secrets
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const DOPPLER_API_BASE = "https://api.doppler.com/v3";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DopplerGetSecretTask {
  taskType: "doppler.get-secret";
  project: string;
  config: string;
  name: string;
}

export interface DopplerListSecretsTask {
  taskType: "doppler.list-secrets";
  project: string;
  config: string;
}

export type DopplerTask = DopplerGetSecretTask | DopplerListSecretsTask;

export interface DopplerSecretResult {
  name: string;
  value: string;
  computed: string;
}

export interface DopplerListResult {
  secrets: Array<{ name: string; value: string }>;
}

// ── Implementation ────────────────────────────────────────────────────────────

async function execute(
  task: DopplerTask,
  ctx: IExecutionContext,
): Promise<DopplerSecretResult | DopplerListResult> {
  const token = requireEnv(ctx, "DOPPLER_TOKEN");
  const authHeader = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;

  if (task.taskType === "doppler.get-secret") {
    ctx.logger.info("doppler.get-secret", { project: task.project, config: task.config });

    const url = new URL(`${DOPPLER_API_BASE}/configs/config/secret`);
    url.searchParams.set("project", task.project);
    url.searchParams.set("config", task.config);
    url.searchParams.set("name", task.name);

    const response = await fetch(url.toString(), {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AdapterHttpError("nexus-adapter-doppler", response.status, body);
    }

    const data = (await response.json()) as {
      secret: { name: string; value: { raw: string; computed: string } };
    };

    return {
      name: data.secret.name,
      value: data.secret.value.raw,
      computed: data.secret.value.computed,
    };
  }

  // doppler.list-secrets
  ctx.logger.info("doppler.list-secrets", { project: task.project, config: task.config });

  const url = new URL(`${DOPPLER_API_BASE}/configs/config/secrets`);
  url.searchParams.set("project", task.project);
  url.searchParams.set("config", task.config);

  const response = await fetch(url.toString(), {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AdapterHttpError("nexus-adapter-doppler", response.status, body);
  }

  const data = (await response.json()) as { secrets: Record<string, { computed: string }> };

  return {
    secrets: Object.entries(data.secrets).map(([name, val]) => ({
      name,
      value: val.computed,
    })),
  };
}

export const dopplerAdapter = defineAdapter<DopplerTask, DopplerSecretResult | DopplerListResult>({
  name: "nexus-adapter-doppler",
  version: "0.1.0",
  capabilities: ["secrets.read"],
  taskTypes: ["doppler.get-secret", "doppler.list-secrets"],
  execute,
});

export default dopplerAdapter;
