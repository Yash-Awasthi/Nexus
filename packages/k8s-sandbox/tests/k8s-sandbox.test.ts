// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  JobManifest,
  MockKubeClient,
  JobWatcher,
  ScientificStack,
  SandboxExecutor,
  STACK_PRESETS,
  type SandboxSpec,
  type K8sJobManifest,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: "test-job",
    namespace: "sandboxes",
    image: "nexus/python:3.12",
    command: ["python", "-c"],
    args: ["print('hello')"],
    activeDeadlineSeconds: 120,
    backoffLimit: 0,
    ...overrides,
  };
}

const noSleep = async (_ms: number) => {};

// ── JobManifest.validate ──────────────────────────────────────────────────────

describe("JobManifest.validate", () => {
  it("returns empty array for valid spec", () => {
    expect(JobManifest.validate(makeSpec())).toHaveLength(0);
  });

  it("rejects empty name", () => {
    const errors = JobManifest.validate(makeSpec({ name: "" }));
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects non-DNS-safe name", () => {
    const errors = JobManifest.validate(makeSpec({ name: "My_Job!" }));
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects missing image", () => {
    const errors = JobManifest.validate(makeSpec({ image: "" }));
    expect(errors.some((e) => e.includes("image"))).toBe(true);
  });

  it("rejects empty command", () => {
    const errors = JobManifest.validate(makeSpec({ command: [] }));
    expect(errors.some((e) => e.includes("command"))).toBe(true);
  });

  it("rejects non-positive activeDeadlineSeconds", () => {
    const errors = JobManifest.validate(makeSpec({ activeDeadlineSeconds: 0 }));
    expect(errors.some((e) => e.includes("activeDeadlineSeconds"))).toBe(true);
  });

  it("accepts valid DNS-safe names", () => {
    expect(JobManifest.validate(makeSpec({ name: "my-job-123" }))).toHaveLength(0);
  });
});

// ── JobManifest.build ─────────────────────────────────────────────────────────

describe("JobManifest.build", () => {
  it("sets apiVersion and kind", () => {
    const m = JobManifest.build(makeSpec());
    expect(m.apiVersion).toBe("batch/v1");
    expect(m.kind).toBe("Job");
  });

  it("sets metadata from spec", () => {
    const m = JobManifest.build(
      makeSpec({
        labels: { env: "test" },
        annotations: { purpose: "ci" },
      }),
    );
    expect(m.metadata.name).toBe("test-job");
    expect(m.metadata.namespace).toBe("sandboxes");
    expect(m.metadata.labels?.["env"]).toBe("test");
    expect(m.metadata.annotations?.["purpose"]).toBe("ci");
  });

  it("defaults namespace to 'default' when not specified", () => {
    const spec = makeSpec();
    delete (spec as any).namespace;
    const m = JobManifest.build(spec);
    expect(m.metadata.namespace).toBe("default");
  });

  it("restartPolicy is always Never", () => {
    const m = JobManifest.build(makeSpec());
    expect(m.spec.template.spec.restartPolicy).toBe("Never");
  });

  it("backoffLimit defaults to 0", () => {
    const spec = makeSpec();
    delete (spec as any).backoffLimit;
    const m = JobManifest.build(spec);
    expect(m.spec.backoffLimit).toBe(0);
  });

  it("activeDeadlineSeconds defaults to 300", () => {
    const spec = makeSpec();
    delete (spec as any).activeDeadlineSeconds;
    const m = JobManifest.build(spec);
    expect(m.spec.activeDeadlineSeconds).toBe(300);
  });

  it("includes env vars in container", () => {
    const spec = makeSpec({ env: [{ name: "FOO", value: "bar" }] });
    const m = JobManifest.build(spec);
    const container = m.spec.template.spec.containers[0]!;
    expect(container.env).toEqual([{ name: "FOO", value: "bar" }]);
  });

  it("includes resources in container", () => {
    const spec = makeSpec({
      resources: {
        requests: { cpu: "500m", memory: "512Mi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
    });
    const m = JobManifest.build(spec);
    const container = m.spec.template.spec.containers[0]!;
    expect(container.resources?.requests?.cpu).toBe("500m");
    expect(container.resources?.limits?.memory).toBe("1Gi");
  });

  it("container name is always 'sandbox'", () => {
    const m = JobManifest.build(makeSpec());
    expect(m.spec.template.spec.containers[0]!.name).toBe("sandbox");
  });

  it("includes args when specified", () => {
    const m = JobManifest.build(makeSpec({ args: ["print('hi')"] }));
    expect(m.spec.template.spec.containers[0]!.args).toEqual(["print('hi')"]);
  });
});

// ── MockKubeClient ────────────────────────────────────────────────────────────

describe("MockKubeClient", () => {
  let client: MockKubeClient;

  beforeEach(() => {
    client = new MockKubeClient({ finalPhase: "succeeded", stdout: "hello", stderr: "" });
  });

  it("submitJob records manifest and returns job name", async () => {
    const m = JobManifest.build(makeSpec());
    const name = await client.submitJob(m);
    expect(name).toBe("test-job");
    expect(client.submittedManifests).toHaveLength(1);
  });

  it("getJobStatus starts at pending then reaches succeeded", async () => {
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    const s1 = await client.getJobStatus("test-job", "sandboxes");
    expect(s1.phase).toBe("succeeded"); // 1 tick = done (ticksToComplete default 1)
  });

  it("phases through running with ticksToComplete > 1", async () => {
    const c = new MockKubeClient({ finalPhase: "succeeded", ticksToComplete: 3 });
    const m = JobManifest.build(makeSpec());
    await c.submitJob(m);
    const s1 = await c.getJobStatus("test-job", "sandboxes");
    expect(s1.phase).toBe("running");
    const s2 = await c.getJobStatus("test-job", "sandboxes");
    expect(s2.phase).toBe("running");
    const s3 = await c.getJobStatus("test-job", "sandboxes");
    expect(s3.phase).toBe("succeeded");
  });

  it("getLogs returns configured stdout/stderr", async () => {
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    const logs = await client.getLogs("test-job", "sandboxes");
    expect(logs.stdout).toBe("hello");
    expect(logs.stderr).toBe("");
  });

  it("deleteJob removes job and records in deletedJobs", async () => {
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    await client.deleteJob("test-job", "sandboxes");
    expect(client.deletedJobs).toContain("sandboxes/test-job");
    await expect(client.getJobStatus("test-job", "sandboxes")).rejects.toThrow("not found");
  });

  it("listJobs returns all jobs for a namespace", async () => {
    const m1 = JobManifest.build(makeSpec({ name: "job-a" }));
    const m2 = JobManifest.build(makeSpec({ name: "job-b" }));
    await client.submitJob(m1);
    await client.submitJob(m2);
    const jobs = await client.listJobs("sandboxes");
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.name)).toContain("job-a");
    expect(jobs.map((j) => j.name)).toContain("job-b");
  });

  it("submitJob throws when submitError is configured", async () => {
    const c = new MockKubeClient({ submitError: "quota exceeded" });
    const m = JobManifest.build(makeSpec());
    await expect(c.submitJob(m)).rejects.toThrow("quota exceeded");
  });

  it("failed phase sets exitCode to 1 by default", async () => {
    const c = new MockKubeClient({ finalPhase: "failed" });
    const m = JobManifest.build(makeSpec());
    await c.submitJob(m);
    const status = await c.getJobStatus("test-job", "sandboxes");
    expect(status.phase).toBe("failed");
    expect(status.exitCode).toBe(1);
  });
});

// ── JobWatcher ────────────────────────────────────────────────────────────────

describe("JobWatcher", () => {
  it("resolves when job succeeds", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded" });
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    const watcher = new JobWatcher(client, noSleep);
    const status = await watcher.watch("test-job", "sandboxes", { pollIntervalMs: 0 });
    expect(status.phase).toBe("succeeded");
  });

  it("resolves when job fails", async () => {
    const client = new MockKubeClient({ finalPhase: "failed" });
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    const watcher = new JobWatcher(client, noSleep);
    const status = await watcher.watch("test-job", "sandboxes", { pollIntervalMs: 0 });
    expect(status.phase).toBe("failed");
  });

  it("throws on timeout", async () => {
    // A job that never completes: we need ticksToComplete very high
    const client = new MockKubeClient({ finalPhase: "succeeded", ticksToComplete: 999 });
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    const watcher = new JobWatcher(client, noSleep);
    await expect(
      watcher.watch("test-job", "sandboxes", { pollIntervalMs: 0, timeoutMs: 1 }),
    ).rejects.toThrow("timed out");
  });

  it("calls onStatus callback for each poll", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded", ticksToComplete: 2 });
    const m = JobManifest.build(makeSpec());
    await client.submitJob(m);
    const statuses: string[] = [];
    const watcher = new JobWatcher(client, noSleep);
    await watcher.watch("test-job", "sandboxes", {
      pollIntervalMs: 0,
      onStatus: (s) => statuses.push(s.phase),
    });
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[statuses.length - 1]).toBe("succeeded");
  });
});

// ── ScientificStack ───────────────────────────────────────────────────────────

describe("ScientificStack", () => {
  it("buildSpec for python uses correct image and command", () => {
    const spec = ScientificStack.buildSpec("python", "import numpy");
    expect(spec.image).toContain("python");
    expect(spec.command).toContain("python");
    expect(spec.args).toEqual(["import numpy"]);
  });

  it("buildSpec for r uses Rscript", () => {
    const spec = ScientificStack.buildSpec("r", "print('hello')");
    expect(spec.image).toContain("r:");
    expect(spec.command).toContain("Rscript");
  });

  it("buildSpec for julia uses julia", () => {
    const spec = ScientificStack.buildSpec("julia", "println(42)");
    expect(spec.image).toContain("julia");
    expect(spec.command).toContain("julia");
  });

  it("includes language label", () => {
    const spec = ScientificStack.buildSpec("python", "x=1");
    expect(spec.labels?.["nexus.io/language"]).toBe("python");
    expect(spec.labels?.["nexus.io/type"]).toBe("scientific-sandbox");
  });

  it("default resources are set", () => {
    const spec = ScientificStack.buildSpec("python", "x=1");
    expect(spec.resources?.requests?.cpu).toBeDefined();
    expect(spec.resources?.limits?.memory).toBeDefined();
  });

  it("custom resources override defaults", () => {
    const spec = ScientificStack.buildSpec("python", "x=1", {
      resources: { requests: { cpu: "2" }, limits: { memory: "8Gi" } },
    });
    expect(spec.resources?.requests?.cpu).toBe("2");
    expect(spec.resources?.limits?.memory).toBe("8Gi");
  });

  it("custom env vars are merged with preset env vars", () => {
    const spec = ScientificStack.buildSpec("python", "x=1", {
      env: [{ name: "MY_VAR", value: "my-val" }],
    });
    const names = spec.env!.map((e) => e.name);
    expect(names).toContain("PYTHONUNBUFFERED");
    expect(names).toContain("MY_VAR");
  });

  it("activeDeadlineSeconds defaults to 120", () => {
    const spec = ScientificStack.buildSpec("python", "x=1");
    expect(spec.activeDeadlineSeconds).toBe(120);
  });

  it("custom namespace is used", () => {
    const spec = ScientificStack.buildSpec("julia", "x=1", { namespace: "ml-jobs" });
    expect(spec.namespace).toBe("ml-jobs");
  });

  it("getPreset returns correct preset for each language", () => {
    expect(ScientificStack.getPreset("python").image).toContain("python");
    expect(ScientificStack.getPreset("r").image).toContain("r:");
    expect(ScientificStack.getPreset("julia").image).toContain("julia");
  });
});

// ── SandboxExecutor ───────────────────────────────────────────────────────────

describe("SandboxExecutor", () => {
  it("execute returns a successful ExecutionResult", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded", stdout: "42\n", stderr: "" });
    const executor = new SandboxExecutor({ client, pollIntervalMs: 0, sleep: noSleep });
    const result = await executor.execute(makeSpec());
    expect(result.phase).toBe("succeeded");
    expect(result.stdout).toBe("42\n");
    expect(result.exitCode).toBe(0);
    expect(result.jobName).toBe("test-job");
  });

  it("execute cleans up job by default", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded" });
    const executor = new SandboxExecutor({ client, sleep: noSleep });
    await executor.execute(makeSpec());
    expect(client.deletedJobs).toContain("sandboxes/test-job");
  });

  it("execute skips cleanup when cleanup: false", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded" });
    const executor = new SandboxExecutor({ client, cleanup: false, sleep: noSleep });
    await executor.execute(makeSpec());
    expect(client.deletedJobs).toHaveLength(0);
  });

  it("execute throws for invalid spec", async () => {
    const client = new MockKubeClient();
    const executor = new SandboxExecutor({ client, sleep: noSleep });
    await expect(executor.execute(makeSpec({ name: "" }))).rejects.toThrow("Invalid spec");
  });

  it("execute handles failed job", async () => {
    const client = new MockKubeClient({
      finalPhase: "failed",
      stderr: "NameError: x",
      exitCode: 1,
    });
    const executor = new SandboxExecutor({ client, sleep: noSleep });
    const result = await executor.execute(makeSpec());
    expect(result.phase).toBe("failed");
    expect(result.stderr).toBe("NameError: x");
    expect(result.exitCode).toBe(1);
  });

  it("execute cleans up even when watch times out", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded", ticksToComplete: 9999 });
    const executor = new SandboxExecutor({ client, timeoutMs: 1, sleep: noSleep });
    await expect(executor.execute(makeSpec())).rejects.toThrow("timed out");
    expect(client.deletedJobs).toContain("sandboxes/test-job");
  });

  it("run convenience method works for python", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded", stdout: "hello\n" });
    const executor = new SandboxExecutor({ client, sleep: noSleep });
    const result = await executor.run("python", "print('hello')");
    expect(result.phase).toBe("succeeded");
    expect(result.stdout).toBe("hello\n");
  });

  it("run uses ScientificStack preset image", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded" });
    const executor = new SandboxExecutor({ client, sleep: noSleep });
    await executor.run("julia", "println(42)");
    const manifest = client.submittedManifests[0]!;
    expect(manifest.spec.template.spec.containers[0]!.image).toContain("julia");
  });

  it("multiple runs submit separate manifests", async () => {
    const client = new MockKubeClient({ finalPhase: "succeeded" });
    const executor = new SandboxExecutor({ client, cleanup: false, sleep: noSleep });
    // Use explicit names to guarantee uniqueness
    await executor.execute(makeSpec({ name: "job-run-1", namespace: "sandboxes" }));
    await executor.execute(makeSpec({ name: "job-run-2", namespace: "sandboxes" }));
    expect(client.submittedManifests).toHaveLength(2);
    expect(client.submittedManifests[0]!.metadata.name).toBe("job-run-1");
    expect(client.submittedManifests[1]!.metadata.name).toBe("job-run-2");
  });
});
