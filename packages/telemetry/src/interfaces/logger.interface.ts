// SPDX-License-Identifier: Apache-2.0
export interface ILogger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, error?: unknown, context?: unknown): void;
  debug(message: string, context?: unknown): void;
}
