// SPDX-License-Identifier: Apache-2.0
// Temporary debug: reproduce the mission hang with progress logging.
import { MissionRunner } from "@nexus/agent-engine";
import { llmDriverToToolFn } from "@nexus/agent-runtime";

import { kvMissionStore } from "../../src/lib/mission-store.js";
import { getDefaultDriver } from "../../src/routes/api-bridge.js";

async function main() {
  const driver = getDefaultDriver();
  console.log("driver:", driver ? "ok" : "undefined");
  if (!driver) return;
  const llm = llmDriverToToolFn(driver);

  const runner = new MissionRunner({
    llm,
    thinkPrompt: "Think step by step about the best approach to this mission before acting.",
    maxIterations: 1,
    acceptScore: 70,
    store: kvMissionStore("repro-user"),
    onProgress: (r) =>
      console.log(
        `phase: ${r.phases.at(-1)?.phase} iter ${r.iteration} status ${r.status} usage ${r.usage.totalTokens}`,
      ),
  });

  const t0 = Date.now();
  console.log("starting run at", new Date().toISOString());
  const record = await runner.run("Say hello in one short sentence. Do not use tools.");
  console.log("done in", Date.now() - t0, "ms status", record.status);
  console.log("phases:", record.phases.map((p) => p.phase).join(" → "));
  console.log("finalContent:", record.finalContent.slice(0, 200));
  process.exit(0);
}

main().catch((e) => {
  console.error("REPRO FAILED:", e);
  process.exit(1);
});
