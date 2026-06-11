import { EventEmitter }   from 'node:events';
import { randomUUID }     from 'node:crypto';
import type { AgentMessage, AgentId, MessagePriority } from './types/index.js';

type MessageId      = string;
type Handler<T>     = (msg: AgentMessage<T>) => void | Promise<void>;
type Unsubscribe    = () => void;

interface PublishOptions {
  from?:          AgentId;
  to?:            AgentId | 'broadcast';
  priority?:      MessagePriority;
  correlationId?: string;
  ttl?:           number;
}

export class MessageBus {
  private readonly emitter = new EventEmitter();
  private readonly log: AgentMessage[] = [];

  constructor() {
    this.emitter.setMaxListeners(200);   // 18 agents × ~10 subscriptions each + headroom
  }

  publish<T>(topic: string, payload: T, opts: PublishOptions = {}): MessageId {
    const msg: AgentMessage<T> = {
      id:            randomUUID(),
      from:          opts.from          ?? 'system',
      to:            opts.to            ?? 'broadcast',
      topic,
      payload,
      priority:      opts.priority      ?? (1 as MessagePriority),  // NORMAL
      timestamp:     Date.now(),
      correlationId: opts.correlationId,
      ttl:           opts.ttl,
    };

    this.log.push(msg);
    this.emitter.emit(topic, msg);
    this.emitter.emit('*', msg);

    return msg.id;
  }

  subscribe<T>(topic: string, handler: Handler<T>): Unsubscribe {
    this.emitter.on(topic, handler as Handler<unknown>);
    return () => this.emitter.off(topic, handler as Handler<unknown>);
  }

  /** Subscribe to every message on the bus. */
  subscribeAll(handler: Handler<unknown>): Unsubscribe {
    this.emitter.on('*', handler);
    return () => this.emitter.off('*', handler);
  }

  /**
   * Request/response — publishes `topic` and awaits a reply on
   * `response.<correlationId>`.  Times out after `timeoutMs`.
   */
  async request<TReq, TRes>(
    topic:     string,
    payload:   TReq,
    timeoutMs: number = 30_000,
  ): Promise<TRes> {
    const correlationId   = randomUUID();
    const responseTopic   = `response.${correlationId}`;

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MessageBus: timeout waiting for "${topic}"`)),
        timeoutMs,
      );

      const unsub = this.subscribe<TRes>(responseTopic, (msg) => {
        clearTimeout(timer);
        unsub();
        resolve(msg.payload);
      });

      this.publish(topic, payload, { correlationId });
    });
  }

  /** Reply to a request. */
  reply<T>(correlationId: string, payload: T): void {
    this.publish(`response.${correlationId}`, payload);
  }

  recent(limit = 100): AgentMessage[] {
    return this.log.slice(-limit);
  }
}
