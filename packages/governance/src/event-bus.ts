// SPDX-License-Identifier: Apache-2.0

export interface IEventBus {
  publish(event: string, payload: unknown): Promise<void>;
  subscribe(event: string, handler: (payload: unknown) => Promise<void>): void;
}
