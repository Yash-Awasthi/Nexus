import type { IEnvironmentTelemetry } from "./interfaces/environment.interface.js";

export class EnvironmentTelemetry implements IEnvironmentTelemetry {
  browserSessionsActive = 0;
  totalBytesFetched = 0;
  totalWritesCount = 0;
  totalBytesWritten = 0;
  navigationHistory: string[] = [];

  recordNavigation(url: string): void {
    this.navigationHistory.push(url);
    if (this.navigationHistory.length > 50) {
      this.navigationHistory.shift();
    }
  }

  recordFetch(bytes: number): void {
    this.totalBytesFetched += bytes;
  }

  recordWrite(bytes: number): void {
    this.totalWritesCount += 1;
    this.totalBytesWritten += bytes;
  }
}
