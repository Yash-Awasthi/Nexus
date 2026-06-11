# GhostStack v1.2.0 Operational Workflows Catalog

This document defines and catalogs the four core workflow templates implemented in the **GhostStack v1.2.0** application layer, focusing on the showcase execution pathways.

---

## 1. Catalog of Core Workflows

### 1.1 Governed Browser Research Workflow

- **Template ID**: `browser-research-template`
- **Objective**: Drive search operations and extract data within a secure sandboxed environment.
- **Safety Policy**: Enforces strict payload quotas and blocks path traversal queries. Requires manual governance approvals if payload limit exceeds baseline quotas.

### 1.2 Local Cloud Provisioning Workflow

- **Template ID**: `local-cloud-provisioning-template`
- **Objective**: Configure local-first infrastructure (ports, configs, directories).
- **Safety Policy**: Validates port allocations and limits directory configurations.

### 1.3 Document Processing Workflow

- **Template ID**: `document-processing-template`
- **Objective**: Parse text documents and compile structured reports.
- **Safety Policy**: Restricts output directory paths and file overwrite commands.

### 1.4 Spec-to-Execution Workflow

- **Template ID**: `spec-to-execution-template`
- **Objective**: Interpret system specifications and coordinate multi-adapter code execution.
- **Safety Policy**: Requires manual governance approval for execution parameters.

---

## 2. Official Showcase Workflow: Governed Browser Research

The **Governed Browser Research Workflow** serves as our primary demonstration vertical slice. It contains two discrete sequential tasks:

1. **Navigation Task** (`showcase-research-nav-task`): Loads search queries using a mock-safe web browser configuration.
2. **Extraction Task** (`showcase-research-scrape-task`): Scrapes structured data payloads, verifying bytes sizes.

### 2.1 Governance Execution Pathways & Outputs

Our automated bootstrap logs demonstrate three distinct paths of this workflow:

#### Path A: Safe Workflow (Standard Limits)

- **Quota Limit**: 5,000 bytes.
- **Execution Outcome**: Compliance validated. Tasks enqueued, executed sequentially, and updated state:
  ```
  [INFO] Tasks sorted in topological order {"sorted":["showcase-safe-research-nav-task","showcase-safe-research-scrape-task"]}
  [INFO] Driving executor task processing loop...
  [SHOWCASE] SAFE Workflow finished with status: succeeded
  ```

#### Path B: Illegal Workflow (Security Traversal Attempt)

- **Malicious Payload**: Description fields contains `file:///etc/passwd` injection.
- **Execution Outcome**: Traversal decider catches directory traversal attack, blocking queue insertion immediately:
  ```
  [SHOWCASE] Executing ILLEGAL Workflow...
  [SHOWCASE] ILLEGAL Workflow execution blocked: status = failed, reason = "Illegal system file path protocol blocked"
  ```

#### Path C: Secure Workflow (Triggers Manual Governance Gate)

- **Quota Limit**: 25,000 bytes (exceeds the 10,000 baseline).
- **Execution Outcome**: Execution held in `pending` queue. An approval record is created. Once approved, the orchestrator executes the task:
  ```
  [SHOWCASE] SECURE Workflow held in: status = pending, approved = false
  [SHOWCASE] Governance Registry pending approval records found: [{ approvalId: 'appr-6817', taskId: 'exec-approval-demo', status: 'pending' }]
  [SHOWCASE] Approving pending governance token request [appr-6817]...
  [SHOWCASE] SECURE Workflow execution completed after approval: status = succeeded
  ```

This showcase provides full empirical verification of our local-first sandboxing and governance controls under real operational conditions.
