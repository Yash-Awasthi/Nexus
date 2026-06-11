// @ts-nocheck
import * as fs from "fs";
import * as yaml from "js-yaml";

export interface PortsConfig {
  floci: number;
  fcc: number;
  mcp: number;
  ollama: number;
  [key: string]: number;
}

export interface ServiceDefinition {
  cmd?: string;
  image?: string;
  type: "docker" | "process" | "external";
  port: number;
}

export interface ServicesConfig {
  services: Record<string, ServiceDefinition>;
}

export interface HealthcheckDefinition {
  path: string;
  interval: number;
}

export interface HealthchecksConfig {
  healthchecks: Record<string, HealthcheckDefinition>;
}

export interface RuntimeConfig {
  version: string;
  environment: string;
  primary_llm: string;
  local_backup: string;
  storage: {
    mode: string;
    interval_sec: number;
  };
}

export interface IConfigLoader {
  loadPorts(): Promise<PortsConfig>;
  loadServices(): Promise<ServicesConfig>;
  loadHealthchecks(): Promise<HealthchecksConfig>;
  loadRuntime(): Promise<RuntimeConfig>;
}

export interface YAMLConfigLoaderOptions {
  portsPath: string;
  servicesPath: string;
  healthchecksPath: string;
  runtimePath: string;
}

export class YAMLConfigLoader implements IConfigLoader {
  private options: YAMLConfigLoaderOptions;

  constructor(options: YAMLConfigLoaderOptions) {
    this.options = options;
  }

  private readYamlFile(filePath: string): any {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return yaml.load(content);
    } catch (err) {
      throw new Error(`Failed to load or parse YAML file at ${filePath}: ${err}`);
    }
  }

  async loadPorts(): Promise<PortsConfig> {
    return this.readYamlFile(this.options.portsPath) as PortsConfig;
  }

  async loadServices(): Promise<ServicesConfig> {
    return this.readYamlFile(this.options.servicesPath) as ServicesConfig;
  }

  async loadHealthchecks(): Promise<HealthchecksConfig> {
    return this.readYamlFile(this.options.healthchecksPath) as HealthchecksConfig;
  }

  async loadRuntime(): Promise<RuntimeConfig> {
    return this.readYamlFile(this.options.runtimePath) as RuntimeConfig;
  }
}
