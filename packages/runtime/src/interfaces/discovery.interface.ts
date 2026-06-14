// SPDX-License-Identifier: Apache-2.0
export interface ServiceHeartbeat {
  name: string;
  status: "healthy" | "unhealthy" | "offline";
  lastCheck: Date;
  details?: unknown;
}

export interface IServiceDiscovery {
  registerService(name: string, port: number, details?: unknown): Promise<void>;
  deregisterService(name: string): Promise<void>;
  getService(name: string): Promise<ServiceHeartbeat | undefined>;
  listServices(): Promise<ServiceHeartbeat[]>;
}

export interface IHealthMonitor {
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  checkService(name: string): Promise<boolean>;
}
