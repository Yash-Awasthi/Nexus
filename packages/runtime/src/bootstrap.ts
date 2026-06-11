// @ts-nocheck
import * as path from "path";

import { createRuntimeContext, startRuntime } from "./runtime-context.js";

export async function bootstrap() {
  const bootStarted = Date.now();
  console.log("\x1b[35m");
  console.log("===============================================================================");
  console.log("   _____ _               _    _____ _             _      __      __ __   __ ");
  console.log("  / ____| |             | |  / ____| |           | |     \\ \\    / //_ | /_ |");
  console.log(" | |  __| |__   ___  ___| |_| (___ | |_ __ _  ___| | __   \\ \\  / /  | |  | |");
  console.log(" | | |_ | '_ \\ / _ \\/ __| __|\\___ \\| __/ _` |/ __| |/ /    \\ \\/ /   | |  | |");
  console.log(" | |__| | | | | (_) \\__ \\ |_ ____) | || (_| | (__|   <      \\  /    | |  | |");
  console.log("  \\_____|_| |_|\\___/|___/\\__|_____/ \\__\\__,_|\\___|_|\\_\\      \\/     |_|  |_|");
  console.log("                                                                               ");
  console.log("          LOCAL-FIRST AUTONOMOUS ORCHESTRATION ENGINE  —  v1.2.0");
  console.log("===============================================================================");
  console.log("\x1b[0m");

  const repoRoot = path.resolve(__dirname, "..");
  const ctx = await createRuntimeContext(repoRoot);

  console.log(`[BOOT] Initializing database directories at: ${ctx.runtimeDbDir}`);
  console.log(`[BOOT] Registered ${ctx.registry.listTemplates().length} workflow templates`);
  console.log(`[BOOT] Loaded ${ctx.registry.listWorkflows().length} workflow definition(s) from specs/`);

  const activeServices = await startRuntime(ctx);
  console.log(`[BOOT] Active orchestration services loaded successfully: ${activeServices.join(", ")}`);

  const runShowcase =
    process.env.GHOSTSTACK_BOOTSTRAP_SHOWCASE === "1" ||
    (process.env.GHOSTSTACK_BOOTSTRAP_SHOWCASE ?? "").toLowerCase() === "true";

  if (!runShowcase) {
    console.log("\n[BOOT] Showcase skipped. Set GHOSTSTACK_BOOTSTRAP_SHOWCASE=true to run demo workflows.");
    console.log("[BOOT] For a persistent API, run: npm start\n");
    ctx.metrics.recordTiming("ghoststack.bootstrap.total_ms", Date.now() - bootStarted);
    return;
  }

  console.log("\n\x1b[32m[SHOWCASE] Running Governed Browser Research Showcase Workflow Demo...\x1b[0m");

  const browserTemplate = ctx.registry.getTemplate("browser-research-template")!;

  console.log("[SHOWCASE] 1. Instantiating SAFE Workflow (quota: 5000 bytes)...");
  const safeWorkflow = browserTemplate.createWorkflow({ id: "showcase-safe-research", limitBytes: 5000 });
  ctx.registry.registerWorkflow(safeWorkflow);

  console.log("[SHOWCASE] Executing SAFE Workflow...");
  const safeExecResult = await ctx.workflowEngine.executeWorkflow("showcase-safe-research", "exec-safe-demo");
  console.log(`[SHOWCASE] SAFE Workflow finished with status: \x1b[32m${safeExecResult.status}\x1b[0m`);

  console.log("\n[SHOWCASE] 2. Instantiating ILLEGAL Workflow (contains path traversal attempt)...");
  const illegalWorkflow = browserTemplate.createWorkflow({ id: "showcase-illegal-research" });
  illegalWorkflow.tasks[0].id = "task-passwd";
  illegalWorkflow.tasks[0].description = "Attempt reading file:///etc/passwd inside sandbox";
  ctx.registry.registerWorkflow(illegalWorkflow);

  console.log("[SHOWCASE] Executing ILLEGAL Workflow...");
  const illegalExecResult = await ctx.workflowEngine.executeWorkflow("showcase-illegal-research", "exec-illegal-demo");
  console.log(
    `[SHOWCASE] ILLEGAL Workflow execution blocked: status = \x1b[31m${illegalExecResult.status}\x1b[0m, reason = "${illegalExecResult.error}"`
  );

  console.log(
    "\n[SHOWCASE] 3. Instantiating SECURE Workflow (quota: 25000 bytes, triggers approval policy decider)..."
  );
  const approvalWorkflow = browserTemplate.createWorkflow({ id: "showcase-approval-research", limitBytes: 25000 });
  ctx.registry.registerWorkflow(approvalWorkflow);

  console.log("[SHOWCASE] Executing SECURE Workflow...");
  const approvalExecResult = await ctx.workflowEngine.executeWorkflow("showcase-approval-research", "exec-approval-demo");
  console.log(
    `[SHOWCASE] SECURE Workflow held in: status = \x1b[33m${approvalExecResult.status}\x1b[0m, approved = ${approvalExecResult.approved}`
  );

  const pendingApprovals = await ctx.approval.listRecords();
  console.log(`[SHOWCASE] Governance Registry pending approval records found:`, pendingApprovals);

  const targetApproval = pendingApprovals.find((r) => r.taskId === "exec-approval-demo")!;
  console.log(`[SHOWCASE] Approving pending governance token request [${targetApproval.approvalId}]...`);

  const approvedResult = await ctx.workflowEngine.approveAndTriggerWorkflow(targetApproval.approvalId);
  console.log(
    `[SHOWCASE] SECURE Workflow execution completed after approval: status = \x1b[32m${approvedResult.status}\x1b[0m`
  );

  ctx.metrics.recordTiming("ghoststack.bootstrap.total_ms", Date.now() - bootStarted);
  console.log(`[BOOT] ghoststack.bootstrap.total_ms=${Date.now() - bootStarted}`);

  console.log("\n\x1b[35m===============================================================================");
  console.log("   GHOSTSTACK BOOTSTRAP DEMONSTRATION COMPLETE - ALL SYSTEMS RUNNING SAFELY");
  console.log("===============================================================================\x1b[0m\n");
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error("[CRITICAL] Bootstrap runtime crashed:", err);
    process.exit(1);
  });
}
