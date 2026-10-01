// SPDX-License-Identifier: Apache-2.0
/**
 * RuntimeManager — central service lifecycle manager for Conductor.
 *
 * Tracks the lifecycle state of named services, supports start/stop/restart,
 * and exposes an aggregated health summary so the HTTP server and CLI can
 * serve a meaningful `/health` response without knowing about individual
 * service implementations.
 */

import type { IConfigLoader } from "./config-loader.js";

// ─── Public types ──────────────────────────────────────────────────────────────

export type ServiceLifecycleStatus = "running" | "stopped" | "degraded" | "error" | "unknown";

export interface ServiceRecord {
  name: string;
  status: ServiceLifecycleStatus;
  startedAt?: Date;
  stoppedAt?: Date;
  /** Number of times this service has been (re)started in the current process. */
  restartCount: number;
  /** Free-form detail from the last health probe or lifecycle event. */
  detail?: string;
  /** Last error message if status === "error". */
  lastError?: string;
}

export interface RuntimeHealthSummary {
  overall: "healthy" | "degraded" | "unhealthy";
  runningCount: number;
  stoppedCount: number;
  degradedCount: number;
  errorCount: number;
  services: ServiceRecord[];
  uptimeMs: number;
}

export interface IRuntimeManager {
  getActiveServices(): Promise<string[]>;
  registerService(name: string, status?: ServiceLifecycleStatus, detail?: string): void;
  unregisterService(name: string): void;
  markRunning(name: string, detail?: string): void;
  markStopped(name: string, detail?: string): void;
  markDegraded(name: string, detail?: string): void;
  markError(name: string, error: string): void;
  startService(name: string, startFn: () => Promise<void>): Promise<void>;
  stopService(name: string, stopFn: () => Promise<void>): Promise<void>;
  restartService(
    name: string,
    stopFn: () => Promise<void>,
    startFn: () => Promise<void>,
  ): Promise<void>;
  getServiceRecord(name: string): ServiceRecord | undefined;
  getAllRecords(): ServiceRecord[];
  getHealthSummary(): RuntimeHealthSummary;
}

// ─── RuntimeManager implementation ────────────────────────────────────────────

export class RuntimeManager implements IRuntimeManager {
  private configLoader: IConfigLoader;
  private services = new Map<string, ServiceRecord>();
  private readonly startedAt = new Date();

  constructor(configLoader: IConfigLoader) {
    this.configLoader = configLoader;
  }

  // ── Config-driven service list ──────────────────────────────────────────────

  async getActiveServices(): Promise<string[]> {
    try {
      const servicesConfig = await this.configLoader.loadServices();
      const configNames = Object.keys(servicesConfig?.services || {});
      const runtimeNames = Array.from(this.services.keys());
      // Return the union of config-declared and runtime-registered service names.
      // Config-declared services are NOT silently auto-registered as "unknown" —
      // callers must call registerService() to get a lifecycle record.
      // This keeps the registry unambiguous: status records exist only for services
      // that have been explicitly registered.
      return Array.from(new Set([...configNames, ...runtimeNames]));
    } catch {
      return Array.from(this.services.keys());
    }
  }

  // ── Registration ────────────────────────────────────────────────────────────

  registerService(name: string, status: ServiceLifecycleStatus = "unknown", detail?: string): void {
    if (this.services.has(name)) {
      const existing = this.services.get(name)!;
      existing.status = status;
      if (detail) existing.detail = detail;
      return;
    }
    this.services.set(name, { name, status, restartCount: 0, detail });
  }

  unregisterService(name: string): void {
    this.services.delete(name);
  }

  // ── Status setters ─────────────────────────────────────────────────────────

  markRunning(name: string, detail?: string): void {
    const record = this._getOrCreate(name);
    record.status = "running";
    record.startedAt = new Date();
    record.stoppedAt = undefined;
    record.lastError = undefined;
    if (detail) record.detail = detail;
  }

  markStopped(name: string, detail?: string): void {
    const record = this._getOrCreate(name);
    record.status = "stopped";
    record.stoppedAt = new Date();
    if (detail) record.detail = detail;
  }

  markDegraded(name: string, detail?: string): void {
    const record = this._getOrCreate(name);
    record.status = "degraded";
    if (detail) record.detail = detail;
  }

  markError(name: string, error: string): void {
    const record = this._getOrCreate(name);
    record.status = "error";
    record.lastError = error;
    record.detail = error;
  }

  // ── Lifecycle helpers ──────────────────────────────────────────────────────

  async startService(name: string, startFn: () => Promise<void>): Promise<void> {
    const record = this._getOrCreate(name);
    try {
      record.detail = "Starting…";
      await startFn();
      record.status = "running";
      record.startedAt = new Date();
      record.restartCount += 1;
      record.lastError = undefined;
      record.detail = undefined;
    } catch (err) {
      record.status = "error";
      record.lastError = (err as Error)?.message || String(err);
      record.detail = record.lastError;
      throw err;
    }
  }

  async stopService(name: string, stopFn: () => Promise<void>): Promise<void> {
    const record = this._getOrCreate(name);
    try {
      record.detail = "Stopping…";
      await stopFn();
      record.status = "stopped";
      record.stoppedAt = new Date();
      record.detail = undefined;
    } catch (err) {
      record.status = "error";
      record.lastError = (err as Error)?.message || String(err);
      record.detail = record.lastError;
      throw err;
    }
  }

  async restartService(
    name: string,
    stopFn: () => Promise<void>,
    startFn: () => Promise<void>,
  ): Promise<void> {
    await this.stopService(name, stopFn);
    await this.startService(name, startFn);
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  getServiceRecord(name: string): ServiceRecord | undefined {
    return this.services.get(name);
  }

  getAllRecords(): ServiceRecord[] {
    return Array.from(this.services.values());
  }

  getHealthSummary(): RuntimeHealthSummary {
    const records = this.getAllRecords();
    const running = records.filter((r) => r.status === "running").length;
    const stopped = records.filter((r) => r.status === "stopped").length;
    const degraded = records.filter((r) => r.status === "degraded").length;
    const error = records.filter((r) => r.status === "error").length;

    let overall: "healthy" | "degraded" | "unhealthy";
    if (error > 0) {
      overall = "unhealthy";
    } else if (degraded > 0) {
      overall = "degraded";
    } else {
      overall = "healthy";
    }

    return {
      overall,
      runningCount: running,
      stoppedCount: stopped,
      degradedCount: degraded,
      errorCount: error,
      services: records,
      uptimeMs: Date.now() - this.startedAt.getTime(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _getOrCreate(name: string): ServiceRecord {
    if (!this.services.has(name)) {
      this.services.set(name, { name, status: "unknown", restartCount: 0 });
    }
    return this.services.get(name)!;
  }
}
