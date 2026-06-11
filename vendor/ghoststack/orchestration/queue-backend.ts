import { IQueueBackend, QueueJob } from "./interfaces/queue.interface";

export class MemoryQueueBackend implements IQueueBackend {
  private activeQueue: QueueJob[] = [];
  private deadLetterQueue: QueueJob[] = [];

  private priorityWeights: Record<string, number> = {
    high: 3,
    medium: 2,
    low: 1
  };

  async push(job: QueueJob): Promise<void> {
    if (job.retries >= job.maxRetries) {
      await this.moveToDeadLetter(job, "Retry attempts exhausted");
      return;
    }
    this.activeQueue.push(job);
  }

  async pop(): Promise<QueueJob | undefined> {
    if (this.activeQueue.length === 0) return undefined;

    this.activeQueue.sort((a, b) => {
      const weightA = this.priorityWeights[a.priority] || 0;
      const weightB = this.priorityWeights[b.priority] || 0;

      if (weightA !== weightB) {
        return weightB - weightA;
      }

      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return this.activeQueue.shift();
  }

  async moveToDeadLetter(job: QueueJob, _error: string): Promise<void> {
    this.activeQueue = this.activeQueue.filter((j) => j.id !== job.id);
    this.deadLetterQueue.push(job);
  }

  async getDeadLetterQueue(): Promise<QueueJob[]> {
    return this.deadLetterQueue;
  }

  async clearDeadLetterQueue(): Promise<void> {
    this.deadLetterQueue = [];
  }

  async getQueueLength(): Promise<number> {
    return this.activeQueue.length;
  }

  async getActiveJobs(): Promise<QueueJob[]> {
    return [...this.activeQueue];
  }
}
