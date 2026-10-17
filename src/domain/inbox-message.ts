import { DomainError } from './money';

export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private currentProcessedAt?: Date,
  ) {}

  static receive(props: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt?: Date;
  }): InboxMessage {
    if (!props.messageId || !props.consumerName || !/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new DomainError('Invalid inbox message identity or hash', 'INVALID_INBOX_MESSAGE');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt ?? new Date());
  }

  static rehydrate(state: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
    processedAt?: Date;
  }): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined { return this.currentProcessedAt; }
  isProcessed(): boolean { return this.currentProcessedAt !== undefined; }

  markProcessed(at: Date): void {
    if (this.currentProcessedAt) {
      throw new DomainError('Inbox message is already processed', 'INVALID_INBOX_STATE');
    }
    this.currentProcessedAt = at;
  }
}
