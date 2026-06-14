// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/pipeline-signal — ingest → classify → signal pipeline
 *
 * Converts raw IngestedEvents into typed Signals that the council
 * can deliberate on. Runs as a polling worker or on-demand processor.
 */

export { SignalClassifier } from "./classifier.js";
export type { ClassificationInput, ClassificationResult, ClassifierRule } from "./classifier.js";

export { SignalProcessor, MemoryEventSource, MemorySignalSink } from "./processor.js";
export type {
  RawEvent,
  IEventSource,
  CreatedSignal,
  ISignalSink,
  ISignalEventBus,
  SignalProcessorConfig,
  ProcessBatchResult,
} from "./processor.js";
