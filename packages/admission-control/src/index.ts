// SPDX-License-Identifier: Apache-2.0
/**
 * Admission Control — queue-based request admission with capacity management.
 *
 * Extracted from LightRAG's admission system: prevents overload by rejecting
 * requests before body read, with ticket ownership transfer across layers.
 *
 * Key insight: the capacity decision happens before first receive() — a request
 * that will be refused never has its body read, but the reservation stays held
 * until background processing completes.
 */

export interface AdmissionTicket {
  token: string;
  weight: number;
  adopted: boolean;
  timestamp: number;
}

export interface AdmissionConfig {
  maxConcurrent: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  weightFn?: (req: any) => number;
}

export interface AdmissionDecision {
  allowed: boolean;
  ticket?: AdmissionTicket;
  queuePosition?: number;
  reason?: string;
}

/**
 * Queue-based admission controller that prevents system overload.
 * Requests get tickets; if capacity is full they queue or get rejected.
 */
export class AdmissionController {
  private active = new Map<string, AdmissionTicket>();
  private queue: AdmissionTicket[] = [];
  private counter = 0;

  constructor(private config: AdmissionConfig) {}

  /**
   * Decide whether to admit a request. Must be called BEFORE reading the body.
   */
  async decide(req?: any): Promise<AdmissionDecision> {
    const weight = this.config.weightFn?.(req) ?? 1;
    const currentLoad = this.currentWeight();

    // Direct admission if under capacity
    if (currentLoad + weight <= this.config.maxConcurrent) {
      const ticket = this.createTicket(weight);
      this.active.set(ticket.token, ticket);
      return { allowed: true, ticket };
    }

    // Queue if room available
    if (this.queue.length < this.config.maxQueueSize) {
      const ticket = this.createTicket(weight);
      this.queue.push(ticket);
      return {
        allowed: false,
        ticket,
        queuePosition: this.queue.length,
        reason: `Queued at position ${this.queue.length}`,
      };
    }

    // Rejected — queue full
    return {
      allowed: false,
      reason: `Capacity full (${currentLoad}/${this.config.maxConcurrent}), queue full (${this.queue.length}/${this.config.maxQueueSize})`,
    };
  }

  /**
   * Adopt a ticket — transfer ownership from middleware to endpoint.
   * Once adopted, middleware won't release it on its finally.
   */
  adopt(token: string): AdmissionTicket | undefined {
    const ticket = this.active.get(token);
    if (ticket) {
      ticket.adopted = true;
    }
    return ticket;
  }

  /**
   * Release a ticket — either from endpoint or background task.
   * Processes next item in queue if available.
   */
  release(token: string): void {
    const ticket = this.active.get(token);
    if (!ticket) return;

    this.active.delete(token);

    // Process queue
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active.set(next.token, next);
    }
  }

  private createTicket(weight: number): AdmissionTicket {
    return {
      token: `adm_${Date.now()}_${++this.counter}`,
      weight,
      adopted: false,
      timestamp: Date.now(),
    };
  }

  private currentWeight(): number {
    let total = 0;
    for (const ticket of this.active.values()) {
      total += ticket.weight;
    }
    return total;
  }

  /** Get current stats */
  stats(): { active: number; queued: number; load: number; max: number } {
    return {
      active: this.active.size,
      queued: this.queue.length,
      load: this.currentWeight(),
      max: this.config.maxConcurrent,
    };
  }
}

/**
 * Express/Fastify middleware that wraps admission control.
 */
export function createAdmissionMiddleware(controller: AdmissionController) {
  return async (req: any, res: any, next: any) => {
    const decision = await controller.decide(req);

    if (!decision.allowed) {
      res.status(429).json({
        error: "Service temporarily unavailable",
        reason: decision.reason,
        retryAfter: 1,
      });
      return;
    }

    // Attach ticket to request
    req.admissionTicket = decision.ticket;

    // Release on response finish if not adopted
    res.on("finish", () => {
      if (decision.ticket && !decision.ticket.adopted) {
        controller.release(decision.ticket.token);
      }
    });

    next();
  };
}
