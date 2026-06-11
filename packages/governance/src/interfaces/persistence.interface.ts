// SPDX-License-Identifier: Apache-2.0

export interface IStoredEvent {
  id: string;
  event: string;
  payload: unknown;
  timestamp: Date;
}

export interface IEventStore {
  saveEvent(event: string, payload: unknown): Promise<IStoredEvent>;
  replayEvents(): Promise<IStoredEvent[]>;
}
