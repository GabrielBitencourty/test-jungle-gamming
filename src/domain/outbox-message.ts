import { DomainError } from './money';
import { IntegrationEvent } from './events';

export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private currentAttempts: number,
    private currentNextAttemptAt?: Date,
    private currentPublishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(event.toJSON()),
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: {
    id: string; aggregateId: string; eventType: string; payload: Readonly<Record<string, unknown>>;
    occurredAt: Date; attempts: number; nextAttemptAt?: Date; publishedAt?: Date;
  }): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType, Object.freeze({ ...state.payload }),
      state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt,
    );
  }

  get attempts(): number { return this.currentAttempts; }
  get nextAttemptAt(): Date | undefined { return this.currentNextAttemptAt; }
  get publishedAt(): Date | undefined { return this.currentPublishedAt; }
  isPending(): boolean { return this.currentPublishedAt === undefined; }
  isDue(now: Date): boolean {
    return this.isPending() && (!this.currentNextAttemptAt || this.currentNextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new DomainError('Outbox message is already published', 'INVALID_OUTBOX_STATE');
    this.currentPublishedAt = at;
    this.currentNextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new DomainError('Cannot retry a published outbox message', 'INVALID_OUTBOX_STATE');
    this.currentAttempts += 1;
    this.currentNextAttemptAt = new Date(now.getTime() + Math.min(300, 2 ** Math.min(this.currentAttempts - 1, 8)) * 1000);
  }
}
