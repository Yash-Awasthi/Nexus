// SPDX-License-Identifier: Apache-2.0
/**
 * Persistence interfaces.
 *
 * IEventStore is defined in interfaces/event-store.interface.ts.
 * This module re-exports it so existing import paths continue to work.
 */

export type { IEventStore } from "./event-store.interface.js";

export interface IRuntimePersistence {
  saveState(key: string, state: unknown, options?: { verifyWrite?: boolean }): Promise<void>;
  getState<T>(key: string): Promise<T | undefined>;
  clearState(key: string): Promise<void>;
}
