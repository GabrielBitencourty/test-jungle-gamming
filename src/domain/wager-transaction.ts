import { DomainError, Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export class WagerTransaction {
  private constructor(
    readonly props: WagerProps,
    private currentStatus: WagerTransactionStatus,
    private currentFailureCode?: string,
    private currentReferenceTransactionId?: string,
    private currentProcessedAt?: Date,
  ) {}

  static create(props: WagerProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError('OPENING is an internal transaction', 'INTERNAL_TRANSACTION');
    }
    if (props.money.isNegative()) {
      throw new DomainError('Transaction amount cannot be negative', 'INVALID_AMOUNT');
    }
    const requiresReference = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]
      .includes(props.kind);
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new DomainError('This transaction requires a reference', 'REFERENCE_REQUIRED');
    }
    return new WagerTransaction(props, WagerTransactionStatus.Pending);
  }

  static rehydrate(
    props: WagerProps,
    status: WagerTransactionStatus,
    failureCode?: string,
    referenceTransactionId?: string,
    processedAt?: Date,
  ): WagerTransaction {
    return new WagerTransaction(props, status, failureCode, referenceTransactionId, processedAt);
  }

  get status(): WagerTransactionStatus { return this.currentStatus; }
  get failureCode(): string | undefined { return this.currentFailureCode; }
  get referenceTransactionId(): string | undefined { return this.currentReferenceTransactionId; }
  get processedAt(): Date | undefined { return this.currentProcessedAt; }
  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]
      .includes(this.currentStatus);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    this.currentStatus = WagerTransactionStatus.Processed;
    this.currentReferenceTransactionId = referenceTransactionId;
    this.currentProcessedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    this.currentStatus = WagerTransactionStatus.PendingReference;
  }

  reject(code: string): void {
    this.assertNotTerminal();
    this.currentStatus = WagerTransactionStatus.Rejected;
    this.currentFailureCode = code;
  }

  fail(code: string): void {
    this.assertNotTerminal();
    this.currentStatus = WagerTransactionStatus.Failed;
    this.currentFailureCode = code;
  }

  affectsBalance(): boolean {
    return this.props.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.props.kind === WagerTransactionKind.Refund || this.props.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(hash: string): boolean {
    return this.props.payloadHash === hash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): 'DEBIT' | 'CREDIT' | undefined {
    switch (this.props.kind) {
      case WagerTransactionKind.Bet:
        return 'DEBIT';
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return 'CREDIT';
      case WagerTransactionKind.Rollback:
        if (!reference) return undefined;
        return reference.props.kind === WagerTransactionKind.Bet ? 'CREDIT' : 'DEBIT';
      case WagerTransactionKind.Loss:
        return undefined;
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new DomainError('Cannot transition a terminal transaction', 'INVALID_TRANSACTION_STATE');
    }
  }
}
