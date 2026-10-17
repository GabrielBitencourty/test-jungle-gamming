import { randomUUID } from 'node:crypto';
import { DomainError, Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(readonly props: Readonly<LedgerEntryProps>) {}

  static create(props: Omit<LedgerEntryProps, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: Date;
  }): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(Object.freeze({
      ...props,
      id: props.id ?? randomUUID(),
      createdAt: props.createdAt ?? new Date(),
    }));
    if (!entry.isBalanced()) {
      throw new DomainError('Ledger entry arithmetic is inconsistent', 'UNBALANCED_LEDGER_ENTRY');
    }
    return entry;
  }

  static rehydrate(props: LedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...props }));
  }

  isBalanced(): boolean {
    if (
      this.props.money.currency !== this.props.balanceBefore.currency ||
      this.props.money.currency !== this.props.balanceAfter.currency ||
      this.props.balanceBefore.isNegative() ||
      this.props.balanceAfter.isNegative() ||
      !this.props.money.isPositive()
    ) return false;
    const expected = this.props.direction === 'CREDIT'
      ? this.props.balanceBefore.add(this.props.money)
      : this.props.balanceBefore.subtract(this.props.money);
    return expected.equals(this.props.balanceAfter);
  }
}
