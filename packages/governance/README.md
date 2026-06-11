<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/governance

Policy engine for NEXUS: execution constraints, guardrails, approval workflow, and capability policies.

Enforces safety boundaries around every task before it executes. Used by `apps/api` and `apps/worker` as a pre-execution gate.

## Installation

Internal monorepo package. Consumed by `apps/api`, `apps/worker`, and `@nexus/runtime`.

```ts
import {
  GovernanceEngine,
  ApprovalWorkflow,
  DangerousOperationPolicy,
  LoopDetectionGuardrail,
} from "@nexus/governance";
```

## Quick start

```ts
const governance = new GovernanceEngine({
  constraints: [
    new ResourceScopeConstraint({ allowedScopes: ["read", "write:own"] }),
    new CostBudgetConstraint({ maxUsdPerTask: 0.1 }),
    new TimeoutConstraint({ maxMs: 120_000 }),
  ],
  policies: [
    new DangerousOperationPolicy({ blocklist: ["rm -rf", "DROP TABLE"] }),
    new WildcardPermissionsPolicy(),
  ],
  guardrails: [
    new LoopDetectionGuardrail({ maxVisits: 3 }),
    new RunawayRetriesGuardrail({ maxRetries: 10 }),
    new TaskGraphLimitGuardrail({ maxNodes: 100 }),
  ],
});

// Gate a task before execution
const verdict = await governance.evaluate(taskMetadata);
if (verdict.allowed) {
  await executeTask(task);
} else {
  log.warn({ reason: verdict.reason }, "task blocked by governance");
}
```

## Components

### Constraints

Hard limits evaluated before the task starts:

| Class                     | Blocks when                                   |
| ------------------------- | --------------------------------------------- |
| `ResourceScopeConstraint` | Task requests a scope not in the allowlist    |
| `CostBudgetConstraint`    | Estimated cost exceeds the per-task budget    |
| `TimeoutConstraint`       | Task declares a timeout exceeding the maximum |

### Policies

Semantic rules over task content:

| Class                       | Blocks when                                               |
| --------------------------- | --------------------------------------------------------- |
| `DangerousOperationPolicy`  | Task payload matches a dangerous-operation blocklist      |
| `WildcardPermissionsPolicy` | Task requests `*` permissions rather than specific scopes |

### Guardrails

Runtime checks that fire during execution:

| Class                     | Triggers when                                                   |
| ------------------------- | --------------------------------------------------------------- |
| `LoopDetectionGuardrail`  | A node in the task graph is visited more than `maxVisits` times |
| `RunawayRetriesGuardrail` | A task has retried more than `maxRetries` times                 |
| `TaskGraphLimitGuardrail` | The task graph exceeds `maxNodes` nodes                         |

### `ApprovalWorkflow`

Human-in-the-loop gate. Tasks flagged by governance are placed in the `approval_requests` table and paused until a human approves or rejects via `POST /v1/governance/approvals/:id`.

```ts
const workflow = new ApprovalWorkflow({ db, notifyFn: sendSlackDM });

const request = await workflow.request({
  taskId: task.id,
  reason: "Dangerous operation requires human approval",
  context: taskMetadata,
});

// Task resumes when approved
await workflow.onApproved(request.id, async () => executeTask(task));
```

## Audit integration

Every governance decision (approved, blocked, escalated) is written to the HMAC-chained `audit_log` table via `@nexus/telemetry`. This provides a tamper-evident record of every policy enforcement action.
