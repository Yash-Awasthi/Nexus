import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { QueueJob } from "../orchestration/interfaces/queue.interface";

describe("Milestone 2: Resilient Priority Queue Engine", () => {
  it("should push jobs and pop them sorted strictly by priority first, then creation time", async () => {
    const queue = new MemoryQueueBackend();

    const lowJob: QueueJob = {
      id: "job-low",
      payload: { action: "low" },
      priority: "low",
      retries: 0,
      maxRetries: 3,
      createdAt: new Date(Date.now() - 10000) // created first
    };

    const highJob: QueueJob = {
      id: "job-high",
      payload: { action: "high" },
      priority: "high",
      retries: 0,
      maxRetries: 3,
      createdAt: new Date()
    };

    await queue.push(lowJob);
    await queue.push(highJob);

    // High priority should pop first despite being created later
    const firstPop = await queue.pop();
    expect(firstPop?.id).toBe("job-high");

    const secondPop = await queue.pop();
    expect(secondPop?.id).toBe("job-low");
  });

  it("should correctly handle retries and move to dead-letter queue when exhausted", async () => {
    const queue = new MemoryQueueBackend();

    const failingJob: QueueJob = {
      id: "job-failing",
      payload: { action: "fail" },
      priority: "medium",
      retries: 0,
      maxRetries: 2,
      createdAt: new Date()
    };

    await queue.push(failingJob);

    // Attempt 1: Pop and fail it
    const attempt1 = await queue.pop();
    expect(attempt1?.retries).toBe(0);
    attempt1!.retries += 1;
    await queue.push(attempt1!); // push back

    // Attempt 2: Pop and fail it again
    const attempt2 = await queue.pop();
    expect(attempt2?.retries).toBe(1);
    attempt2!.retries += 1;
    await queue.push(attempt2!); // push back

    // Attempt 3: Exhausted! It should be routed to Dead Letter Queue (DLQ)
    const attempt3 = await queue.pop();
    expect(attempt3).toBeUndefined(); // removed from main queue

    const dlq = await queue.getDeadLetterQueue();
    expect(dlq.length).toBe(1);
    expect(dlq[0].id).toBe("job-failing");
    expect(dlq[0].retries).toBe(2);
  });
});
