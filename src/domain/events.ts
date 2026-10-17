import { randomUUID } from 'node:crypto';
import { MoneyProps } from './money';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(
    readonly aggregateId: string,
    readonly correlationId: string,
    data: T,
    readonly causationId?: string,
  ) {
    this.eventId = randomUUID();
    this.occurredAt = new Date();
    this.data = Object.freeze(data);
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  constructor(aggregateId: string, correlationId: string, data: Record<string, unknown>, causationId?: string) {
    super(aggregateId, correlationId, data, causationId);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  constructor(aggregateId: string, correlationId: string, data: Record<string, unknown>, causationId?: string) {
    super(aggregateId, correlationId, data, causationId);
  }
}

export class WalletBalanceChanged extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    data: {
      walletId: string;
      transactionId: string;
      direction: 'DEBIT' | 'CREDIT';
      money: MoneyProps;
      balanceBefore: MoneyProps;
      balanceAfter: MoneyProps;
      walletVersion: number;
    },
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(data.walletId, ctx.correlationId, data, ctx.causationId);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  constructor(aggregateId: string, correlationId: string, data: Record<string, unknown>, causationId?: string) {
    super(aggregateId, correlationId, data, causationId);
  }
}
