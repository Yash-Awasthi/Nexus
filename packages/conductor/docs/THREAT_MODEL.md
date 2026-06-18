# GhostStack v1.2.0 Threat Model & Concurrency Defense Blueprint

This document details identified security vectors, systemic threats, validation boundaries, and active structural mitigations implemented in **GhostStack v1.2.0**.

---

## 1. Core Threat Surface Analysis

### 1.1 Sandbox Escape & File Path Traversal

- **Threat Vector**: A governed workflow task injects malicious filesystem queries (e.g., `file:///etc/passwd`, `..\..\..\private.key`) through template parameters or dynamic execution code blocks.
- **System Impact**: Potential unauthorized host file leakage or deletion.
- **Mitigation**:
  - Implemented strict input validation boundaries in the `GovernanceEngine` (via `FileTraversalDecider`).
  - Blocks all path traversals containing directory dots `..`, root prefixes `/etc/`, or absolute root paths on Windows `C:\` that are outside of the local data sandbox directory (`data-runtime/`).

### 1.2 Event Replay Poisoning

- **Threat Vector**: An attacker manipulates `events.jsonl` on disk, inserting synthetic events to trick the event stream loader during orchestrator startup.
- **System Impact**: Submitting arbitrary fake execution outcomes, bypassing active worker loops, or injecting corrupted states.
- **Mitigation**:
  - `FileEventStore` parses event structures strictly against JSON Schemas (`schemas/orchestration.schema.json`).
  - Any malformed or logically disjointed trace timeline event (e.g., success outcome for a non-existent task ID) is logged as critical, halts bootstrap, and pushes the event data to an isolated quarantine snapshot.

### 1.3 Queue Abuse & Starvation (Denial of Service)

- **Threat Vector**: An agent or workflow template enters an infinite loop, flooding the priority queue with thousands of low-priority or failing tasks.
- **System Impact**: Memory exhaustion and worker starvation.
- **Mitigation**:
  - Hardened exponential backoff retries (`maxRetries: 3`) on the task execution adapter substrate.
  - Tasks violating retries are moved instantly to the `deadLetterQueue`, allowing the worker threads to process healthy queued tasks.

### 1.4 Approval Bypass & State Tampering

- **Threat Vector**: Directly calling the execution engine, bypassing the governance decider to run high-quota or system tasks without approvals.
- **System Impact**: Bypassing manual gates to execute system commands.
- **Mitigation**:
  - The `WorkflowEngine` strictly couples task queuing to the `GovernanceEngine` evaluation step.
  - Submitting unapproved tasks triggers an immediate execution block, marking the status as `failed` with error reason `Requires approval`.

---

## 2. Dynamic Input Confinement Strategy

The system enforces a **Zero-Trust Input Sanitization Flow** at every stage:

```
[Dynamic Task Request]
         ↓
 [JSON Schema Validation]   --> Fails? Reject.
         ↓
 [Governance Path Filter]   --> Traversal Detected? Reject.
         ↓
  [Quota Threshold Check]   --> Exceeded? Move to Approval Hold.
         ↓
 [Sandboxed Adapter Run]
```

This strict workflow protects host machines and local runtime environments from arbitrary or malicious script execution.
