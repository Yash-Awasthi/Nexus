// SPDX-License-Identifier: Apache-2.0
/**
 * Persistence interfaces.
 *
 * IEventStore is defined in interfaces/event-store.interface.ts.
 * This module re-exports it so existing import paths continue to work.
 */

export { IEventStore } from "./event-store.interface";

export interface IRuntimePersistence {
  saveState(key: string, state: any, options?: { verifyWrite?: boolean }): Promise<void>;
  getState<T>(key: string): Promise<T | undefined>;
  clearState(key: string): Promise<void>;
}
