// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compressOutputForCommand } from "./token-saver.js";

describe("kubectlOutputProcessor — get/describe/logs", () => {
  it("rolls healthy pods up while keeping unhealthy ones verbatim", () => {
    const rows = ["NAME   READY   STATUS    RESTARTS   AGE"];
    rows.push("web-0   1/1     Running   0          10m");
    rows.push("web-1   1/1     Running   0          10m");
    rows.push("db-0    0/1     CrashLoopBackOff   5   10m");
    for (let i = 2; i < 8; i++) rows.push(`api-${i}   1/1     Running   0          10m`);
    rows.push("worker-0   0/1     Pending    0          10m");
    const r = compressOutputForCommand("kubectl get pods", rows.join("\n"));
    expect(r.processor).toBe("kubectl");
    expect(r.wasCompressed).toBe(true);
    // the AGE column is stripped, so unhealthy pods keep their status + restarts
    expect(r.output).toContain("CrashLoopBackOff");
    expect(r.output).toContain("Pending");
    // 8 healthy pods collapse to a single roll-up line (unhealthy stay raw)
    expect(r.output).toContain("... (8 pods Running/Ready)");
    expect(r.output).not.toContain("web-1");
  });

  it("strips the AGE column from wide get output", () => {
    const rows = ["NAME          READY   STATUS    RESTARTS   AGE"];
    for (let i = 0; i < 12; i++) rows.push(`pod-${i}        1/1     Running   0          12m`);
    const r = compressOutputForCommand("kubectl -n prod get pods", rows.join("\n"));
    expect(r.processor).toBe("kubectl");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).not.toContain("AGE");
    expect(r.output).toContain("... (12 pods Running/Ready)");
  });

  it("keeps describe warnings and container state while dropping noise sections", () => {
    const out = [
      "Name:         web-0",
      "Namespace:    prod",
      "Node:         node-1/10.0.0.5",
      "Labels:       app=web",
      "Annotations:  deployment.kubernetes.io/revision: 3",
      "Status:       Running",
      "Containers:",
      "  web:",
      "    Image:          nginx:1.25",
      "    State:          Running",
      "      Started:      Tue, 02 Jan 2026 10:00:00",
      "    Restart Count:  2",
      "Tolerations:",
      "  node.kubernetes.io/not-ready:NoExecute",
      "Events:",
      "  Type     Reason     Age    From             Message",
      "  Normal   Scheduled  10m    default-scheduler  Successfully assigned",
      "  Warning  BackOff    2m     kubelet          Back-off restarting failed container",
    ].join("\n");
    const r = compressOutputForCommand("kubectl describe pod web-0", out);
    expect(r.processor).toBe("kubectl");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("Name:         web-0");
    expect(r.output).toContain("Image:          nginx:1.25");
    expect(r.output).toContain("Warning  BackOff");
    expect(r.output).toContain("Restart Count:  2");
    // noise sections are dropped entirely
    expect(r.output).not.toContain("Tolerations");
    expect(r.output).not.toContain("Annotations");
    expect(r.output).not.toContain("Normal   Scheduled");
  });

  it("compresses kubectl logs with head/error-context/tail", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++)
      lines.push(`2026-01-01T00:00:${String(i).padStart(2, "0")}Z info request ${i}`);
    lines.splice(15, 0, "2026-01-01T00:00:15Z ERROR panic in handler");
    const r = compressOutputForCommand("kubectl logs -n prod web-0 --tail=200", lines.join("\n"));
    expect(r.processor).toBe("kubectl");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("info request 0");
    expect(r.output).toContain("ERROR panic in handler");
    // error-bearing middles get the "showing errors" marker (python behavior)
    expect(r.output).toContain("showing errors");
    expect(r.output).toContain("info request 29");
  });

  it("summarizes apply output to mutation result lines", () => {
    const out = Array.from({ length: 25 }, (_, i) => `deployment.apps/app-${i} configured`);
    out.push("Warning: kubectl apply should be used with care", "error: unable to recognize");
    const r = compressOutputForCommand("kubectl apply -f deploy/", out.join("\n"));
    expect(r.processor).toBe("kubectl");
    expect(r.output).toContain("deployment.apps/app-0 configured");
    expect(r.output).toContain("error: unable to recognize");
  });
});

describe("dockerProcessor — ps/images/logs/inspect", () => {
  // Real `docker ps` pads every field to its header column width (tabwriter).
  const psCols = [
    { n: "CONTAINER ID", w: 16 },
    { n: "IMAGE", w: 16 },
    { n: "COMMAND", w: 24 },
    { n: "CREATED", w: 16 },
    { n: "STATUS", w: 24 },
    { n: "PORTS", w: 24 },
    { n: "NAMES", w: 0 },
  ];
  const psHeader = psCols.map((c) => c.n.padEnd(c.w)).join("");
  const psRow = (vals: string[]): string =>
    psCols.map((c, i) => (vals[i] ?? "").padEnd(c.w)).join("");
  const psOut = [
    psHeader,
    psRow([
      "a1b2c3d4e5f6",
      "nginx:1.25",
      '"/docker-entrypoint."',
      "2 hours ago",
      "Up 2 hours",
      "0.0.0.0:80->80/tcp",
      "web",
    ]),
    psRow([
      "b2c3d4e5f6a7",
      "redis:7",
      '"docker-entrypoint.s"',
      "3 hours ago",
      "Up 3 hours",
      "0.0.0.0:6379->6379/tcp",
      "cache",
    ]),
    psRow([
      "c3d4e5f6a7b8",
      "old-image",
      '"bash"',
      "5 days ago",
      "Exited (0) 5 days ago",
      "",
      "stale",
    ]),
    psRow([
      "d4e5f6a7b8c9",
      "app:latest",
      "/bin/sh -c 'run'",
      "1 minute ago",
      "Up 1 minute",
      "8080/tcp",
      "api-0",
    ]),
  ].join("\n");

  it("drops ID/COMMAND columns and groups containers by state", () => {
    const r = compressOutputForCommand("docker ps -a", psOut);
    expect(r.processor).toBe("docker");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("Running (3):");
    expect(r.output).toContain("  web  (nginx:1.25)  Up 2 hours  0.0.0.0:80->80/tcp");
    expect(r.output).toContain("Stopped (1):");
    expect(r.output).toContain("stale");
    expect(r.output).not.toContain("CONTAINER ID");
    expect(r.output).not.toContain("COMMAND");
  });

  it("summarizes docker images and counts dangling ones", () => {
    const rows = [
      "REPOSITORY   TAG       IMAGE ID       CREATED      SIZE",
      "nginx        1.25      a1b2c3         2 days ago   190MB",
      "redis        7         b2c3d4         3 days ago   138MB",
      "<none>       <none>    e5f6a7         5 days ago   42MB",
      "app          latest    f6a7b8         1 hour ago   250MB",
    ].join("\n");
    const r = compressOutputForCommand("docker images", rows);
    expect(r.processor).toBe("docker");
    expect(r.output).toContain("4 images:");
    expect(r.output).toContain("  nginx:1.25  190MB");
    expect(r.output).toContain("  (1 dangling images)");
    expect(r.output).not.toContain("<none>");
  });

  it("keeps error context in docker logs with head + tail", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++)
      lines.push(`2026-01-01T10:00:${String(i).padStart(2, "0")}Z level=info msg="serving ${i}"`);
    lines[12] = `2026-01-01T10:00:12Z level=error msg="boom ${String.fromCharCode(123)}key=value${String.fromCharCode(125)}"`;
    const r = compressOutputForCommand("docker logs --tail 500 api", lines.join("\n"));
    expect(r.processor).toBe("docker");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("serving 0");
    expect(r.output).toContain("level=error");
    expect(r.output).toContain("showing errors");
    expect(r.output).toContain("serving 24");
  });

  it("groups docker compose logs per service with error counts", () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) lines.push(`api       | 10:00:0${i % 10} info request ${i}`);
    lines.push("api       | 10:00:15 ERROR handler crashed");
    for (let i = 0; i < 6; i++) lines.push(`worker    | 10:00:0${i} processing job ${i}`);
    const r = compressOutputForCommand("docker compose logs -f", lines.join("\n"));
    expect(r.processor).toBe("docker");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("22 log lines across 2 services:");
    expect(r.output).toContain("--- api (16 lines, 1 errors) ---");
    expect(r.output).toContain("ERROR handler crashed");
    expect(r.output).toContain("--- worker (6 lines, 0 errors) ---");
  });

  it("summarizes docker inspect JSON to key fields", () => {
    const obj = {
      Id: "abc123".padEnd(64, "0"),
      Name: "/api",
      Image: "sha256:deadbeef",
      State: { Status: "running", Running: true, Pid: 42, ExitCode: 0 },
      Config: {
        Image: "app:latest",
        Cmd: ["node", "index.js"],
        Env: ["A=1", "B=2", "C=3", "D=4", "E=5", "F=6"],
      },
      NetworkSettings: {
        Ports: { "8080/tcp": [] },
        Networks: { bridge: { IPAddress: "172.17.0.2" } },
      },
    };
    const out = JSON.stringify([obj], null, 2);
    const r = compressOutputForCommand("docker inspect api", out);
    expect(r.processor).toBe("docker");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("State:");
    expect(r.output).toContain("  Status: running");
    expect(r.output).toContain("Config:");
    expect(r.output).toContain("  Env: [6 items]");
    expect(r.output).toContain("bridge: 172.17.0.2");
    expect(r.output).toMatch(/total lines\)/);
  });

  it("strips docker pull layer progress but keeps the digest line", () => {
    const out = [
      "node:20: Pulling from library/node",
      "a1b2c3: Pulling fs layer",
      "a1b2c3: Downloading  45%",
      "a1b2c3: Download complete",
      "a1b2c3: Pull complete",
      "Digest: sha256:abcdef123456",
      "Status: Downloaded newer image for node:20",
    ].join("\n");
    const r = compressOutputForCommand("docker pull node:20", out);
    expect(r.processor).toBe("docker");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("Digest: sha256:abcdef123456");
    expect(r.output).not.toContain("Downloading");
    expect(r.output).not.toContain("45%");
  });
});
