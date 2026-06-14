// SPDX-License-Identifier: Apache-2.0

export interface IEnvironmentTelemetry {
  recordCapabilityUse(capability: string, durationMs: number): void;
  getUsageStats(): Record<string, { count: number; totalMs: number }>;
}

export interface IExecutionEnvironment {
  name: string;
  capabilities: string[];
  telemetry: IEnvironmentTelemetry;
}

export interface ICapabilityPolicy {
  evaluateCapability(
    taskType: string,
    environment: IExecutionEnvironment,
  ): Promise<{ allowed: boolean; reason?: string }>;
}
