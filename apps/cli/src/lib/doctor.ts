// SPDX-License-Identifier: Apache-2.0
/**
 * `nexus doctor` — one line per local prerequisite, each with the fix.
 *
 * This reads the environment, not the API: the point is to tell a new
 * contributor which piece is missing before the first chat fails. Checks that
 * legitimately have no local requirement (no Redis, embedded PGlite, no
 * Docker) say so instead of failing.
 */
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorRow {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  /** Run a command; undefined when it is missing or exits non-zero. */
  run: (command: string, args: string[]) => Promise<string | undefined>;
  /** Whether a TCP host:port accepts a connection quickly. */
  tcp: (host: string, port: number) => Promise<boolean>;
  /** JSON from a local HTTP endpoint, or undefined when it is down. */
  fetchJson: (url: string) => Promise<unknown | undefined>;
}

const MIN_NODE_MAJOR = 24;

function urlPort(raw: string, fallback: number): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(raw);
    return {
      host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname,
      port: Number(parsed.port) || fallback,
    };
  } catch {
    return undefined;
  }
}

export async function collectDoctor(
  env: NodeJS.ProcessEnv = process.env,
  deps: DoctorDeps = realDeps(),
): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  rows.push(
    major >= MIN_NODE_MAJOR
      ? { name: "node", status: "ok", detail: process.version }
      : {
          name: "node",
          status: "fail",
          detail: `${process.version} (needs ${MIN_NODE_MAJOR}+)`,
          fix: `install Node ${MIN_NODE_MAJOR} or newer`,
        },
  );

  const pnpm = await deps.run("pnpm", ["--version"]);
  rows.push(
    pnpm
      ? { name: "pnpm", status: "ok", detail: pnpm.trim() }
      : { name: "pnpm", status: "fail", detail: "not found", fix: "npm install -g pnpm" },
  );

  const database = env.DATABASE_URL;
  if (!database || database.startsWith("pglite:") || database.startsWith("file:")) {
    rows.push({
      name: "postgres",
      status: "ok",
      detail: database ? "embedded PGlite" : "embedded PGlite (DATABASE_URL unset)",
      fix: "set DATABASE_URL=postgresql://user:pass@host:5432/nexus for the server",
    });
  } else {
    const target = urlPort(database, 5432);
    const reachable = target ? await deps.tcp(target.host, target.port) : false;
    rows.push(
      reachable
        ? { name: "postgres", status: "ok", detail: `${target?.host}:${target?.port}` }
        : {
            name: "postgres",
            status: "fail",
            detail: target ? `${target.host}:${target.port} unreachable` : "invalid DATABASE_URL",
            fix: "start Postgres (docker compose up postgres) or unset DATABASE_URL",
          },
    );
  }

  const redis = env.REDIS_URL;
  if (!redis) {
    rows.push({ name: "redis", status: "ok", detail: "in-process queue (REDIS_URL unset)" });
  } else {
    const target = urlPort(redis, 6379);
    const reachable = target ? await deps.tcp(target.host, target.port) : false;
    rows.push(
      reachable
        ? { name: "redis", status: "ok", detail: `${target?.host}:${target?.port}` }
        : {
            name: "redis",
            status: "fail",
            detail: target ? `${target.host}:${target.port} unreachable` : "invalid REDIS_URL",
            fix: "start Redis (docker compose up redis) or unset REDIS_URL",
          },
    );
  }

  const docker = await deps.run("docker", ["--version"]);
  rows.push(
    docker
      ? { name: "docker", status: "ok", detail: docker.trim().replace(/^Docker version /, "") }
      : {
          name: "docker",
          status: "fail",
          detail: "not found",
          fix: "install Docker Desktop; sandboxed code execution needs it",
        },
  );

  const image = env.NEXUS_SANDBOX_IMAGE ?? "nexus-sandbox:local";
  if (!docker) {
    rows.push({
      name: "sandbox image",
      status: "warn",
      detail: `${image} not checked (no Docker)`,
    });
  } else {
    const listed = await deps.run("docker", ["image", "inspect", image]);
    rows.push(
      listed
        ? { name: "sandbox image", status: "ok", detail: image }
        : {
            name: "sandbox image",
            status: "fail",
            detail: `${image} missing`,
            fix: "docker build -t nexus-sandbox:local infra/sandbox",
          },
    );
  }

  const tags = (await deps.fetchJson("http://127.0.0.1:11434/api/tags")) as
    | { models?: { name?: string }[] }
    | undefined;
  if (!tags) {
    rows.push({
      name: "ollama",
      status: "fail",
      detail: "127.0.0.1:11434 unreachable",
      fix: "install Ollama and run `ollama serve`",
    });
  } else {
    const names = (tags.models ?? []).flatMap((model) => (model.name ? [model.name] : []));
    rows.push({
      name: "ollama",
      status: "ok",
      detail: `${names.length} model(s)`,
    });
    const wanted = env.OLLAMA_MODEL ?? "qwen2.5:7b";
    rows.push(
      names.includes(wanted) || names.some((name) => name.startsWith(wanted))
        ? { name: "model", status: "ok", detail: wanted }
        : {
            name: "model",
            status: "warn",
            detail: `${wanted} not pulled`,
            fix: `ollama pull ${wanted}`,
          },
    );
  }

  return rows;
}

export function formatDoctor(rows: readonly DoctorRow[]): string {
  return rows
    .map((row) => {
      const mark = row.status === "ok" ? "✓" : row.status === "warn" ? "!" : "✗";
      const fix = row.status !== "ok" && row.fix ? `  fix: ${row.fix}` : "";
      return `${mark} ${row.name.padEnd(14)} ${row.detail}${fix}`;
    })
    .join("\n");
}

function realDeps(): DoctorDeps {
  return {
    run: async (command, args) => {
      // npm puts .cmd shims on PATH on Windows; CreateProcess cannot run one
      // without a command interpreter, so quote every argument into cmd /c.
      const quote = (value: string) =>
        /^[A-Za-z0-9_.:@-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
      const via = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : command;
      const argv =
        process.platform === "win32"
          ? ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")]
          : args;
      try {
        const { stdout } = await exec(via, argv, { timeout: 4000, windowsHide: true });
        return stdout;
      } catch {
        return undefined;
      }
    },
    tcp: (host, port) =>
      new Promise((resolve) => {
        const socket = connect({ host, port });
        const done = (open: boolean) => {
          socket.destroy();
          resolve(open);
        };
        socket.setTimeout(800, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
      }),
    fetchJson: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
        return response.ok ? await response.json() : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
