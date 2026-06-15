// SPDX-License-Identifier: Apache-2.0
/**
 * k8s-sandbox — Kubernetes job manifest builder + scientific stack executor.
 *
 * Provides injectable, testable abstractions for running code in ephemeral K8s
 * Job pods (Python/R/Julia scientific stacks).  All K8s API calls go through
 * an injectable KubeClient so tests never need a real cluster.
 *
 * Provides:
 *   • JobManifest        — typed K8s Job manifest builder
 *   • ResourceSpec       — CPU / memory / GPU constraints
 *   • SandboxSpec        — complete execution specification
 *   • KubeClient         — injectable K8s API interface
 *   • MockKubeClient     — in-memory mock for tests
 *   • JobWatcher         — poll-based job status watcher
 *   • SandboxExecutor    — orchestrates submit → watch → logs → cleanup
 *   • ScientificStack    — preset image + env-var resolver for Python/R/Julia
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type Language = "python" | "r" | "julia";
/** Job phase type alias. */
export type JobPhase = "pending" | "running" | "succeeded" | "failed" | "unknown";

/** Resource spec interface definition. */
export interface ResourceSpec {
  cpu?: string;    // e.g. "500m", "2"
  memory?: string; // e.g. "512Mi", "4Gi"
  gpu?: number;    // number of GPU units
}

/** Env var interface definition. */
export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
}

/** Volume mount interface definition. */
export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

/** Sandbox spec interface definition. */
export interface SandboxSpec {
  /** Unique job name (DNS-safe). */
  name: string;
  namespace?: string;
  image: string;
  command: string[];
  args?: string[];
  env?: EnvVar[];
  resources?: { requests?: ResourceSpec; limits?: ResourceSpec };
  volumeMounts?: VolumeMount[];
  /** Seconds before the job is force-killed (default: 300). */
  activeDeadlineSeconds?: number;
  /** Number of retries on failure (default: 0). */
  backoffLimit?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** K8s job manifest interface definition. */
export interface K8sJobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    backoffLimit: number;
    activeDeadlineSeconds: number;
    template: {
      metadata: { labels?: Record<string, string> };
      spec: {
        restartPolicy: "Never";
        containers: Array<{
          name: string;
          image: string;
          command: string[];
          args?: string[];
          env?: EnvVar[];
          resources?: { requests?: ResourceSpec; limits?: ResourceSpec };
          volumeMounts?: VolumeMount[];
        }>;
      };
    };
  };
}

/** Job status interface definition. */
export interface JobStatus {
  name: string;
  namespace: string;
  phase: JobPhase;
  startTime?: string;
  completionTime?: string;
  message?: string;
  exitCode?: number;
}

/** Execution result interface definition. */
export interface ExecutionResult {
  jobName: string;
  namespace: string;
  phase: JobPhase;
  stdout: string;
  stderr: string;
  exitCode?: number;
  startTime?: string;
  completionTime?: string;
  durationMs?: number;
}

// ── JobManifest builder ───────────────────────────────────────────────────────

export class JobManifest {
  static build(spec: SandboxSpec): K8sJobManifest {
    const namespace = spec.namespace ?? "default";
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: spec.name,
        namespace,
        ...(spec.labels ? { labels: spec.labels } : {}),
        ...(spec.annotations ? { annotations: spec.annotations } : {}),
      },
      spec: {
        backoffLimit: spec.backoffLimit ?? 0,
        activeDeadlineSeconds: spec.activeDeadlineSeconds ?? 300,
        template: {
          metadata: { labels: spec.labels ?? {} },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "sandbox",
                image: spec.image,
                command: spec.command,
                ...(spec.args ? { args: spec.args } : {}),
                ...(spec.env ? { env: spec.env } : {}),
                ...(spec.resources ? { resources: spec.resources } : {}),
                ...(spec.volumeMounts ? { volumeMounts: spec.volumeMounts } : {}),
              },
            ],
          },
        },
      },
    };
  }

  /** Validate a spec — returns array of validation errors (empty = valid). */
  static validate(spec: SandboxSpec): string[] {
    const errors: string[] = [];
    if (!spec.name || !/^[a-z0-9-]+$/.test(spec.name)) {
      errors.push("name must be a non-empty DNS-safe string (lowercase, digits, hyphens)");
    }
    if (!spec.image) errors.push("image must be specified");
    if (!spec.command || spec.command.length === 0) errors.push("command must be non-empty");
    if (spec.activeDeadlineSeconds !== undefined && spec.activeDeadlineSeconds <= 0) {
      errors.push("activeDeadlineSeconds must be > 0");
    }
    return errors;
  }
}

// ── KubeClient interface ──────────────────────────────────────────────────────

export interface KubeClient {
  /** Submit a job manifest. Returns job name. */
  submitJob(manifest: K8sJobManifest): Promise<string>;
  /** Get current job status. */
  getJobStatus(name: string, namespace: string): Promise<JobStatus>;
  /** Fetch logs from the job's pod. */
  getLogs(name: string, namespace: string): Promise<{ stdout: string; stderr: string }>;
  /** Delete (cleanup) the job. */
  deleteJob(name: string, namespace: string): Promise<void>;
  /** List all jobs in a namespace. */
  listJobs(namespace: string): Promise<JobStatus[]>;
}

// ── MockKubeClient ────────────────────────────────────────────────────────────

export interface MockJobBehavior {
  finalPhase?: JobPhase;
  /** After how many status polls does the job reach finalPhase (default: 1) */
  ticksToComplete?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  submitError?: string;
}

/** Mock kube client. */
export class MockKubeClient implements KubeClient {
  private jobs = new Map<string, { status: JobStatus; ticks: number; behavior: MockJobBehavior }>();
  readonly submittedManifests: K8sJobManifest[] = [];
  readonly deletedJobs: string[] = [];

  constructor(private defaultBehavior: MockJobBehavior = {}) {}

  async submitJob(manifest: K8sJobManifest): Promise<string> {
    this.submittedManifests.push(manifest);
    const behavior = this.defaultBehavior;
    if (behavior.submitError) throw new Error(behavior.submitError);

    const name = manifest.metadata.name;
    const namespace = manifest.metadata.namespace;
    this.jobs.set(`${namespace}/${name}`, {
      ticks: 0,
      behavior,
      status: {
        name,
        namespace,
        phase: "pending",
        startTime: new Date().toISOString(),
      },
    });
    return name;
  }

  async getJobStatus(name: string, namespace: string): Promise<JobStatus> {
    const key = `${namespace}/${name}`;
    const entry = this.jobs.get(key);
    if (!entry) throw new Error(`Job not found: ${key}`);

    entry.ticks++;
    const ticksNeeded = entry.behavior.ticksToComplete ?? 1;

    if (entry.ticks === 1 && ticksNeeded > 1) {
      entry.status = { ...entry.status, phase: "running" };
    } else if (entry.ticks >= ticksNeeded) {
      const phase = entry.behavior.finalPhase ?? "succeeded";
      entry.status = {
        ...entry.status,
        phase,
        completionTime: new Date().toISOString(),
        exitCode: entry.behavior.exitCode ?? (phase === "succeeded" ? 0 : 1),
      };
    }

    return { ...entry.status };
  }

  async getLogs(name: string, namespace: string): Promise<{ stdout: string; stderr: string }> {
    const key = `${namespace}/${name}`;
    const entry = this.jobs.get(key);
    if (!entry) throw new Error(`Job not found: ${key}`);
    return {
      stdout: entry.behavior.stdout ?? `Mock stdout for ${name}`,
      stderr: entry.behavior.stderr ?? "",
    };
  }

  async deleteJob(name: string, namespace: string): Promise<void> {
    const key = `${namespace}/${name}`;
    this.jobs.delete(key);
    this.deletedJobs.push(`${namespace}/${name}`);
  }

  async listJobs(namespace: string): Promise<JobStatus[]> {
    return [...this.jobs.values()]
      .filter((e) => e.status.namespace === namespace)
      .map((e) => ({ ...e.status }));
  }

  /** Test helper: set custom behavior per job name. */
  setBehavior(name: string, namespace: string, behavior: MockJobBehavior): void {
    const key = `${namespace}/${name}`;
    const entry = this.jobs.get(key);
    if (entry) entry.behavior = behavior;
  }
}

// ── JobWatcher ────────────────────────────────────────────────────────────────

export interface WatchOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: JobStatus) => void;
}

/** Job watcher. */
export class JobWatcher {
  private client: KubeClient;
  private sleep: (ms: number) => Promise<void>;

  constructor(client: KubeClient, sleep?: (ms: number) => Promise<void>) {
    this.client = client;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Poll until job reaches a terminal phase or timeout. */
  async watch(name: string, namespace: string, opts: WatchOptions = {}): Promise<JobStatus> {
    const { pollIntervalMs = 2000, timeoutMs = 300_000, onStatus } = opts;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.client.getJobStatus(name, namespace);
      onStatus?.(status);

      if (status.phase === "succeeded" || status.phase === "failed") {
        return status;
      }

      await this.sleep(pollIntervalMs);
    }

    throw new Error(`Job ${name} timed out after ${timeoutMs}ms`);
  }
}

// ── ScientificStack ───────────────────────────────────────────────────────────

export interface StackPreset {
  image: string;
  defaultCommand: string[];
  extraEnv?: EnvVar[];
}

/** Stack presets. */
export const STACK_PRESETS: Record<Language, StackPreset> = {
  python: {
    image: "nexus/scientific-python:3.12",
    defaultCommand: ["python", "-c"],
    extraEnv: [
      { name: "PYTHONUNBUFFERED", value: "1" },
      { name: "PYTHONDONTWRITEBYTECODE", value: "1" },
    ],
  },
  r: {
    image: "nexus/scientific-r:4.3",
    defaultCommand: ["Rscript", "-e"],
    extraEnv: [
      { name: "R_LIBS_USER", value: "/usr/local/lib/R/site-library" },
    ],
  },
  julia: {
    image: "nexus/scientific-julia:1.10",
    defaultCommand: ["julia", "-e"],
    extraEnv: [
      { name: "JULIA_NUM_THREADS", value: "auto" },
    ],
  },
};

/** Scientific stack. */
export class ScientificStack {
  /** Build a SandboxSpec for running a code snippet in the given language. */
  static buildSpec(
    language: Language,
    code: string,
    opts: {
      name?: string;
      namespace?: string;
      resources?: { requests?: ResourceSpec; limits?: ResourceSpec };
      env?: EnvVar[];
      activeDeadlineSeconds?: number;
    } = {},
  ): SandboxSpec {
    const preset = STACK_PRESETS[language];
    const name = opts.name ?? `sandbox-${language}-${Date.now()}`;

    return {
      name,
      namespace: opts.namespace ?? "sandboxes",
      image: preset.image,
      command: preset.defaultCommand,
      args: [code],
      env: [...(preset.extraEnv ?? []), ...(opts.env ?? [])],
      resources: opts.resources ?? {
        requests: { cpu: "250m", memory: "256Mi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
      activeDeadlineSeconds: opts.activeDeadlineSeconds ?? 120,
      backoffLimit: 0,
      labels: { "nexus.io/language": language, "nexus.io/type": "scientific-sandbox" },
    };
  }

  static getPreset(language: Language): StackPreset {
    return STACK_PRESETS[language];
  }
}

// ── SandboxExecutor ───────────────────────────────────────────────────────────

export interface ExecutorOptions {
  client: KubeClient;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Whether to delete the job after execution (default: true) */
  cleanup?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Sandbox executor. */
export class SandboxExecutor {
  private client: KubeClient;
  private watcher: JobWatcher;
  private cleanup: boolean;
  private watchOpts: WatchOptions;

  constructor(opts: ExecutorOptions) {
    this.client = opts.client;
    this.cleanup = opts.cleanup ?? true;
    this.watchOpts = {
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
      timeoutMs: opts.timeoutMs ?? 300_000,
    };
    this.watcher = new JobWatcher(opts.client, opts.sleep);
  }

  /** Execute a sandbox: submit → watch → fetch logs → (cleanup) → return result. */
  async execute(spec: SandboxSpec): Promise<ExecutionResult> {
    const errors = JobManifest.validate(spec);
    if (errors.length > 0) throw new Error(`Invalid spec: ${errors.join(", ")}`);

    const namespace = spec.namespace ?? "default";
    const manifest = JobManifest.build(spec);
    const jobName = await this.client.submitJob(manifest);

    let finalStatus: JobStatus;
    try {
      finalStatus = await this.watcher.watch(jobName, namespace, this.watchOpts);
    } catch (err) {
      if (this.cleanup) await this.client.deleteJob(jobName, namespace).catch(() => {});
      throw err;
    }

    const logs = await this.client.getLogs(jobName, namespace);

    if (this.cleanup) {
      await this.client.deleteJob(jobName, namespace).catch(() => {});
    }

    const startMs = finalStatus.startTime ? new Date(finalStatus.startTime).getTime() : undefined;
    const endMs = finalStatus.completionTime ? new Date(finalStatus.completionTime).getTime() : undefined;

    return {
      jobName,
      namespace,
      phase: finalStatus.phase,
      stdout: logs.stdout,
      stderr: logs.stderr,
      exitCode: finalStatus.exitCode,
      startTime: finalStatus.startTime,
      completionTime: finalStatus.completionTime,
      durationMs: startMs && endMs ? endMs - startMs : undefined,
    };
  }

  /** Convenience: build spec from ScientificStack and execute. */
  async run(
    language: Language,
    code: string,
    opts?: Parameters<typeof ScientificStack.buildSpec>[2],
  ): Promise<ExecutionResult> {
    const spec = ScientificStack.buildSpec(language, code, opts);
    return this.execute(spec);
  }
}
