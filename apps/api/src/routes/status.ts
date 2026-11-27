// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /status` — one JSON document that says whether each dependency this service needs is
 * actually answering.
 *
 * It exists because `/health/ready` answers a load balancer's question ("should I send traffic
 * here") and is deliberately cheap and cached, while a person asking "is anything broken" wants
 * the dependencies named. So this route probes all five — Postgres, Redis, the model provider
 * registry, the sandbox and Docker — and returns one row each, with the SLI named for the row.
 *
 * It caches for the same reason `/health/ready` does: probing Postgres and Redis on every poll
 * keeps a free database awake. A row that is down is re-checked sooner than one that is healthy.
 *
 * Nothing here names a provider, a key, a host or a version of a dependency: a public status
 * page is a target, and "postgres 16.2 on db-3" is a gift to whoever is scanning.
 */
import { db } from "@nexus/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { getProviderSnapshot, getProviderStats } from "../lib/llm-failover.ts";
import { getSharedKV } from "../lib/shared-kv.ts";

/** One dependency's answer. */
export interface StatusRow {
  name: "postgres" | "redis" | "model" | "sandbox" | "docker";
  ok: boolean;
  /** What was measured, in one sentence. Never a host, a key or a version string. */
  detail: string;
  /** True when the service cannot do its job without this. */
  critical: boolean;
  ms: number;
}

export interface StatusReport {
  status: "ok" | "degraded" | "down";
  version: string;
  commit?: string;
  uptimeSeconds: number;
  checkedAt: string;
  rows: StatusRow[];
}

/** How long a healthy answer stands, and how soon a broken one is asked again. */
const OK_TTL_MS = 30 * 60_000;
const BAD_TTL_MS = 15_000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number }> {
  const started = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - started };
  } catch {
    return { value: null, ms: Date.now() - started };
  }
}

/**
 * The five probes.
 *
 * `sandbox` and `docker` come in as functions because they are promises resolved at boot by the
 * sandbox route: a status page may report what the sandbox route believes, but it must not start
 * a Docker client of its own to find out.
 */
export function statusProbes(deps: {
  dockerReady: Promise<boolean>;
  sandboxReady: () => boolean;
}): {
  name: StatusRow["name"];
  critical: boolean;
  probe: () => Promise<{ ok: boolean; detail: string }>;
}[] {
  return [
    {
      name: "postgres",
      critical: true,
      probe: async () => {
        await db.execute(sql`select 1`);
        return { ok: true, detail: "answered a select 1" };
      },
    },
    {
      name: "redis",
      critical: false,
      probe: async () => {
        const kv = getSharedKV();
        await kv.set("status:probe", Date.now(), 5000);
        const back = await kv.get<number>("status:probe");
        return back === undefined
          ? { ok: false, detail: "wrote a key and read nothing back" }
          : { ok: true, detail: "round-tripped a key" };
      },
    },
    {
      name: "model",
      critical: true,
      probe: async () => {
        // The registry, not a completion: spending money on a health check is a way to make an
        // outage expensive. "No provider configured" is the failure this row exists to catch.
        const providers = getProviderSnapshot();
        const stats = getProviderStats().providers;
        // A provider that has failed every attempt it ever made is not accepting calls; one that
        // has answered at least once is. Neither number names which provider it was.
        const accepting = providers.filter((entry) => {
          const stat = stats.find((s) => s.id === entry.id);
          return !stat || stat.failures < Math.max(1, stat.attempts);
        });
        return accepting.length > 0
          ? {
              ok: true,
              detail: `${accepting.length} of ${providers.length} providers accepting calls`,
            }
          : {
              ok: false,
              detail: `no provider is accepting calls (${providers.length} known)`,
            };
      },
    },
    {
      name: "sandbox",
      critical: false,
      probe: async () => {
        const ready = deps.sandboxReady();
        return ready
          ? { ok: true, detail: "the execute route is mounted" }
          : { ok: false, detail: "the sandbox is disabled in this deployment" };
      },
    },
    {
      name: "docker",
      critical: false,
      probe: async () => {
        // A daemon that answers means the image languages can run; one that does not means only
        // the in-process runtimes are available, which is a degradation, not an outage.
        const ready = await Promise.race([
          deps.dockerReady,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000).unref?.()),
        ]);
        return ready
          ? { ok: true, detail: "the daemon answered" }
          : { ok: false, detail: "no daemon answered; the image languages are unavailable" };
      },
    },
  ];
}

/** Roll the rows into one word, by the worst critical failure. */
export function summarise(rows: StatusRow[]): StatusReport["status"] {
  if (rows.some((row) => row.critical && !row.ok)) return "down";
  if (rows.some((row) => !row.ok)) return "degraded";
  return "ok";
}

export async function statusRoutes(
  app: FastifyInstance,
  deps: { dockerReady: Promise<boolean>; sandboxReady?: () => boolean },
): Promise<void> {
  const probes = statusProbes({
    dockerReady: deps.dockerReady,
    sandboxReady: deps.sandboxReady ?? (() => true),
  });
  const startedAt = Date.now();
  let cached: { at: number; status: StatusReport["status"]; report: StatusReport } | null = null;

  app.get("/status", async (_req, reply) => {
    reply.header("Cache-Control", "no-cache");
    const reuse = cached?.status === "ok" ? OK_TTL_MS : BAD_TTL_MS;
    if (cached && Date.now() - cached.at < reuse) {
      return reply.code(cached.status === "down" ? 503 : 200).send(cached.report);
    }

    const rows = await Promise.all(
      probes.map(async (probe) => {
        const { value, ms } = await timed(probe.probe);
        return {
          name: probe.name,
          critical: probe.critical,
          ok: value?.ok ?? false,
          detail: value?.detail ?? "the probe threw",
          ms,
        } satisfies StatusRow;
      }),
    );
    const status = summarise(rows);
    const report: StatusReport = {
      status,
      version: process.env.npm_package_version ?? "0.1.0",
      ...(process.env.RENDER_GIT_COMMIT
        ? { commit: process.env.RENDER_GIT_COMMIT.slice(0, 7) }
        : {}),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checkedAt: new Date().toISOString(),
      rows,
    };
    cached = { at: Date.now(), status, report };
    // A page watching this wants to see "degraded" without the platform pulling the pod out of
    // rotation: only "down" is a 503, matching /health/ready.
    return reply.code(status === "down" ? 503 : 200).send(report);
  });
}
