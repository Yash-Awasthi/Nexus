// SPDX-License-Identifier: Apache-2.0

export interface IStoredEvent {
  id: string;
  event: string;
  payload: unknown;
  timestamp: Date;
}

/** Minimal event shape required by ApprovalWorkflow.rebuildState. */
export interface IEventRecord {
  event: string;
  payload: unknown;
}

export interface IEventStore {
  // Return type is void — callers never consume the saved record.
  // FileEventStore (runtime) satisfies this; the original Promise<IStoredEvent>
  // return was incompatible because FileEventStore.saveEvent returns void.
  saveEvent(event: string, payload: unknown): Promise<void>;
  // Optional since? parameter aligns with FileEventStore.replayEvents signature.
  replayEvents(since?: Date): Promise<IEventRecord[]>;
}
