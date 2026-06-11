// SPDX-License-Identifier: Apache-2.0
export interface RetryPolicy {
  maxRetries: number;
  backoffFactorMs: number;
}

export interface QueueJob<T = any> {
  id: string;
  payload: T;
  priority: "low" | "medium" | "high";
  retries: number;
  maxRetries: number;
  createdAt: Date;
}

export interface IQueueBackend {
  push(job: QueueJob): Promise<void>;
  pop(): Promise<QueueJob | undefined>;
  moveToDeadLetter(job: QueueJob, error: string): Promise<void>;
  getDeadLetterQueue(): Promise<QueueJob[]>;
  /** Remove all jobs from the dead-letter queue (e.g. after recycling them). */
  clearDeadLetterQueue(): Promise<void>;
  getQueueLength(): Promise<number>;
  getActiveJobs(): Promise<QueueJob[]>;
}
