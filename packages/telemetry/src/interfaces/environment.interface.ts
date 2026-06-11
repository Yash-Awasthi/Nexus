// SPDX-License-Identifier: Apache-2.0
export interface IEnvironmentTelemetry {
  browserSessionsActive: number;
  totalBytesFetched: number;
  totalWritesCount: number;
  totalBytesWritten: number;
  navigationHistory: string[];
  recordNavigation(url: string): void;
  recordFetch(bytes: number): void;
  recordWrite(bytes: number): void;
}
