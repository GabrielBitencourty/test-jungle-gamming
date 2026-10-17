import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

describe('WalletLedgerEntry', () => {
  test('validates credit and debit arithmetic', () => {
    const before = Money.from({ amount: '12.00', currency: 'BRL' });
    const amount = Money.from({ amount: '2.00', currency: 'BRL' });
    expect(WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: 'CREDIT',
      money: amount,
      balanceBefore: before,
      balanceAfter: Money.from({ amount: '14.00', currency: 'BRL' }),
    }).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'transaction-2',
      direction: 'DEBIT',
      money: amount,
      balanceBefore: before,
      balanceAfter: before,
    })).toThrow('arithmetic is inconsistent');
  });
});
