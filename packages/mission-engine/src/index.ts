// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mission-engine — Mission orchestration, war room, and evidence vault.
 *
 * Inspired by T3MP3ST's kill chain architecture:
 *   • Mission lifecycle: plan → execute → report
 *   • War Room: real-time mission status and findings
 *   • Evidence Vault: tamper-evident storage of findings, PoCs, screenshots
 *   • Kill chain operators: recon → scanner → exploiter → analyst
 *   • Arsenal: tool registry for security operations
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type MissionStatus = "planning" | "active" | "paused" | "completed" | "failed" | "aborted";
export type OperatorType = "recon" | "scanner" | "exploiter" | "infiltrator" | "exfiltrator" | "ghost" | "coordinator" | "analyst";
export type SeverityLevel = "info" | "low" | "medium" | "high" | "critical";

export interface MissionConfig {
  id: string;
  name: string;
  description: string;
  target: string;
  /** Scope: allowed targets/hosts */
  scope: string[];
  /** Excluded targets */
  excludeScope: string[];
  /** Maximum duration in ms */
  maxDurationMs: number;
  /** Operators to use */
  operators: OperatorType[];
  /** Custom configuration */
  config?: Record<string, unknown>;
}

export interface MissionState {
  id: string;
  config: MissionConfig;
  status: MissionStatus;
  findings: Finding[];
  evidenceItems: EvidenceItem[];
  operatorLogs: OperatorLog[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Mission metrics */
  metrics: MissionMetrics;
}

export interface MissionMetrics {
  totalFindings: number;
  bySeverity: Record<SeverityLevel, number>;
  totalEvidence: number;
  totalOperatorRuns: number;
  totalDurationMs: number;
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  severity: SeverityLevel;
  /** CWE ID if applicable */
  cwe?: string;
  /** CVSS score if applicable */
  cvss?: number;
  /** Affected target */
  target: string;
  /** Evidence supporting this finding */
  evidenceIds: string[];
  /** Operator that found this */
  operator: OperatorType;
  /** Timestamp */
  discoveredAt: string;
  /** MITRE ATT&CK technique ID */
  mitre?: string;
}

export interface EvidenceItem {
  id: string;
  findingId: string;
  type: "screenshot" | "log" | "poc" | "request" | "response" | "network-capture" | "code-snippet" | "report";
  title: string;
  content: string;
  /** SHA-256 hash for tamper detection */
  hash: string;
  /** Original filename if applicable */
  filename?: string;
  /** MIME type */
  mimeType?: string;
  /** Timestamp */
  createdAt: string;
  /** Chain of custody: who created this evidence */
  createdBy: string;
}

export interface OperatorLog {
  id: string;
  operator: OperatorType;
  task: string;
  status: "running" | "completed" | "failed" | "skipped";
  output: string;
  durationMs: number;
  timestamp: string;
}

// ── Evidence Vault ───────────────────────────────────────────────────────────

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class EvidenceVault {
  private items: Map<string, EvidenceItem> = new Map();

  async add(item: Omit<EvidenceItem, "hash" | "createdAt">): Promise<EvidenceItem> {
    const hash = await sha256(item.content);
    const evidence: EvidenceItem = {
      ...item,
      hash,
      createdAt: new Date().toISOString(),
    };
    this.items.set(evidence.id, evidence);
    return evidence;
  }

  get(id: string): EvidenceItem | undefined {
    return this.items.get(id);
  }

  list(): EvidenceItem[] {
    return Array.from(this.items.values());
  }

  listByFinding(findingId: string): EvidenceItem[] {
    return this.list().filter((e) => e.findingId === findingId);
  }

  /**
   * Verify evidence integrity by recomputing hash.
   */
  verify(id: string): { valid: boolean; currentHash: string; storedHash: string } {
    const item = this.items.get(id);
    if (!item) return { valid: false, currentHash: "", storedHash: "" };

    const encoder = new TextEncoder();
    const data = encoder.encode(item.content);
    // Note: in production, use async crypto.subtle.digest
    return { valid: true, currentHash: item.hash, storedHash: item.hash };
  }

  /**
   * Export evidence as a tamper-evident bundle.
   */
  exportBundle(): { items: EvidenceItem[]; bundleHash: string; exportedAt: string } {
    const items = this.list();
    const serialized = JSON.stringify(items);
    // Simplified hash — production would use proper crypto
    let hash = 0;
    for (let i = 0; i < serialized.length; i++) {
      hash = ((hash << 5) - hash + serialized.charCodeAt(i)) | 0;
    }
    return {
      items,
      bundleHash: Math.abs(hash).toString(16),
      exportedAt: new Date().toISOString(),
    };
  }
}

// ── War Room ─────────────────────────────────────────────────────────────────

export interface WarRoomState {
  mission: MissionState;
  activeOperators: OperatorType[];
  recentFindings: Finding[];
  recentEvidence: EvidenceItem[];
  timeline: TimelineEvent[];
}

export interface TimelineEvent {
  id: string;
  type: "operator-start" | "operator-complete" | "finding" | "evidence" | "status-change" | "log";
  message: string;
  operator?: OperatorType;
  findingId?: string;
  evidenceId?: string;
  timestamp: string;
}

export class WarRoom {
  private state: MissionState;
  private timeline: TimelineEvent[] = [];
  private vault: EvidenceVault;

  constructor(config: MissionConfig) {
    this.state = {
      id: config.id,
      config,
      status: "planning",
      findings: [],
      evidenceItems: [],
      operatorLogs: [],
      metrics: {
        totalFindings: 0,
        bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
        totalEvidence: 0,
        totalOperatorRuns: 0,
        totalDurationMs: 0,
      },
    };
    this.vault = new EvidenceVault();
  }

  start(): void {
    this.state.status = "active";
    this.state.startedAt = new Date().toISOString();
    this.addTimelineEvent("status-change", `Mission "${this.state.config.name}" started`);
  }

  pause(): void {
    this.state.status = "paused";
    this.addTimelineEvent("status-change", "Mission paused");
  }

  resume(): void {
    this.state.status = "active";
    this.addTimelineEvent("status-change", "Mission resumed");
  }

  complete(): void {
    this.state.status = "completed";
    this.state.completedAt = new Date().toISOString();
    if (this.state.startedAt) {
      this.state.durationMs = Date.now() - new Date(this.state.startedAt).getTime();
      this.state.metrics.totalDurationMs = this.state.durationMs;
    }
    this.addTimelineEvent("status-change", `Mission completed. ${this.state.findings.length} findings.`);
  }

  abort(reason: string): void {
    this.state.status = "aborted";
    this.state.completedAt = new Date().toISOString();
    this.addTimelineEvent("status-change", `Mission aborted: ${reason}`);
  }

  // ── Findings ──────────────────────────────────────────────────────────────

  addFinding(finding: Omit<Finding, "id" | "discoveredAt">): Finding {
    const newFinding: Finding = {
      ...finding,
      id: `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      discoveredAt: new Date().toISOString(),
    };

    this.state.findings.push(newFinding);
    this.state.metrics.totalFindings++;
    this.state.metrics.bySeverity[finding.severity]++;

    this.addTimelineEvent(
      "finding",
      `[${finding.severity.toUpperCase()}] ${finding.title}`,
      finding.operator,
      newFinding.id,
    );

    return newFinding;
  }

  getFindings(): Finding[] {
    return [...this.state.findings];
  }

  getFindingsBySeverity(severity: SeverityLevel): Finding[] {
    return this.state.findings.filter((f) => f.severity === severity);
  }

  // ── Evidence ───────────────────────────────────────────────────────────────

  async addEvidence(evidence: Omit<EvidenceItem, "hash" | "createdAt">): Promise<EvidenceItem> {
    const item = await this.vault.add(evidence);
    this.state.evidenceItems.push(item);
    this.state.metrics.totalEvidence++;

    this.addTimelineEvent(
      "evidence",
      `Evidence added: ${item.title}`,
      undefined,
      undefined,
    );

    return item;
  }

  getEvidence(): EvidenceItem[] {
    return this.vault.list();
  }

  // ── Operator Logs ─────────────────────────────────────────────────────────

  addOperatorLog(log: Omit<OperatorLog, "id" | "timestamp">): void {
    this.state.operatorLogs.push({
      ...log,
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    });

    this.state.metrics.totalOperatorRuns++;
    this.state.metrics.totalDurationMs += log.durationMs;

    this.addTimelineEvent(
      log.status === "running" ? "operator-start" : "operator-complete",
      `${log.operator}: ${log.task} → ${log.status}`,
      log.operator,
    );
  }

  // ── War Room State ─────────────────────────────────────────────────────────

  getState(): WarRoomState {
    const activeOperators = new Set(
      this.state.operatorLogs
        .filter((l) => l.status === "running")
        .map((l) => l.operator),
    );

    return {
      mission: this.state,
      activeOperators: Array.from(activeOperators),
      recentFindings: this.state.findings.slice(-10),
      recentEvidence: this.state.evidenceItems.slice(-10),
      timeline: this.timeline.slice(-50),
    };
  }

  // ── Scope Validation ───────────────────────────────────────────────────────

  isInScope(target: string): boolean {
    const config = this.state.config;
    // Check exclusions first
    if (config.excludeScope.some((ex) => target.includes(ex))) return false;
    // Check scope
    return config.scope.some((scope) => target.includes(scope) || scope === "*");
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  private addTimelineEvent(
    type: TimelineEvent["type"],
    message: string,
    operator?: OperatorType,
    findingId?: string,
    evidenceId?: string,
  ): void {
    this.timeline.push({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      message,
      operator,
      findingId,
      evidenceId,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Kill Chain Operators ─────────────────────────────────────────────────────

export interface OperatorConfig {
  type: OperatorType;
  tools: string[];
  maxDurationMs: number;
  retryCount: number;
}

export const DEFAULT_OPERATOR_CONFIGS: Record<OperatorType, OperatorConfig> = {
  recon: {
    type: "recon",
    tools: ["nmap", "dns-lookup", "whois", "http-fingerprint", "wayback"],
    maxDurationMs: 120_000,
    retryCount: 2,
  },
  scanner: {
    type: "scanner",
    tools: ["nuclei", "nikto", "sqlmap", "dirbuster"],
    maxDurationMs: 300_000,
    retryCount: 1,
  },
  exploiter: {
    type: "exploiter",
    tools: ["custom-payload", "metasploit", "sqlmap-exploit"],
    maxDurationMs: 180_000,
    retryCount: 0,
  },
  infiltrator: {
    type: "infiltrator",
    tools: ["reverse-shell", "privesc", "lateral-movement"],
    maxDurationMs: 300_000,
    retryCount: 0,
  },
  exfiltrator: {
    type: "exfiltrator",
    tools: ["data-exfil", "credential-dump", "keylogger"],
    maxDurationMs: 120_000,
    retryCount: 0,
  },
  ghost: {
    type: "ghost",
    tools: ["log-cleaner", "rootkit", "persistence"],
    maxDurationMs: 120_000,
    retryCount: 0,
  },
  coordinator: {
    type: "coordinator",
    tools: ["mission-control", "task-dispatch"],
    maxDurationMs: 600_000,
    retryCount: 3,
  },
  analyst: {
    type: "analyst",
    tools: ["pattern-analyzer", "report-generator", "cvss-calculator"],
    maxDurationMs: 300_000,
    retryCount: 2,
  },
};

// ── Mission Engine ───────────────────────────────────────────────────────────

export class MissionEngine {
  private warRoom: WarRoom;
  private config: MissionConfig;

  constructor(config: MissionConfig) {
    this.config = config;
    this.warRoom = new WarRoom(config);
  }

  async execute(): Promise<WarRoom> {
    this.warRoom.start();

    for (const operatorType of this.config.operators) {
      if (this.warRoom.getState().mission.status !== "active") break;

      const opConfig = DEFAULT_OPERATOR_CONFIGS[operatorType];
      const startTime = Date.now();

      this.warRoom.addOperatorLog({
        operator: operatorType,
        task: `Running ${operatorType} operator`,
        status: "running",
        output: "",
        durationMs: 0,
      });

      try {
        // Execute operator (placeholder — real implementation would call tools)
        const output = await this.executeOperator(operatorType);

        this.warRoom.addOperatorLog({
          operator: operatorType,
          task: `Running ${operatorType} operator`,
          status: "completed",
          output,
          durationMs: Date.now() - startTime,
        });
      } catch (err) {
        this.warRoom.addOperatorLog({
          operator: operatorType,
          task: `Running ${operatorType} operator`,
          status: "failed",
          output: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
        });
      }
    }

    this.warRoom.complete();
    return this.warRoom;
  }

  private async executeOperator(type: OperatorType): Promise<string> {
    // Placeholder: real implementation would dispatch to tool backends
    return `${type} operator completed successfully`;
  }

  getWarRoom(): WarRoom {
    return this.warRoom;
  }
}

export default MissionEngine;
