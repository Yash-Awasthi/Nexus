import { ICapabilityPolicy, IExecutionEnvironment, IEnvironmentTelemetry } from "./interfaces/environment.interface.js";

export class ExecutionEnvironment implements IExecutionEnvironment {
  constructor(
    public name: string,
    public capabilities: string[],
    public telemetry: IEnvironmentTelemetry
  ) {}
}

export class CapabilityPolicy implements ICapabilityPolicy {
  async evaluateCapability(
    taskType: string,
    environment: IExecutionEnvironment
  ): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    if (taskType === "browser" && !environment.capabilities.includes("BROWSER_INTERACT")) {
      return {
        allowed: false,
        reason: `Capability violation: Task requires BROWSER_INTERACT but environment ${environment.name} lacks it.`
      };
    }

    if (taskType === "scraping" && !environment.capabilities.includes("NETWORK_ACCESS")) {
      return {
        allowed: false,
        reason: `Capability violation: Task requires NETWORK_ACCESS but environment ${environment.name} lacks it.`
      };
    }

    if (taskType === "sandbox" && !environment.capabilities.includes("FILESYSTEM_WRITE")) {
      return {
        allowed: false,
        reason: `Capability violation: Task requires FILESYSTEM_WRITE but environment ${environment.name} lacks it.`
      };
    }

    return { allowed: true };
  }
}
