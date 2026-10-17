import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const props = {
  id: 'transaction-1',
  providerId: 'provider',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider:external-1',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '1.00', currency: 'BRL' }),
};

describe('WagerTransaction', () => {
  test('has explicit non-terminal and terminal transitions', () => {
    const transaction = WagerTransaction.create(props);
    transaction.markPendingReference();
    transaction.markProcessed(undefined, new Date());
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(() => transaction.reject('INVALID')).toThrow('terminal transaction');
  });

  test('requires references for refund and rollback and blocks opening', () => {
    expect(() => WagerTransaction.create({ ...props, kind: WagerTransactionKind.Refund }))
      .toThrow('requires a reference');
    expect(() => WagerTransaction.create({ ...props, kind: WagerTransactionKind.Opening }))
      .toThrow('internal transaction');
  });

  test('assigns ledger direction and balance impact for each operation', () => {
    const bet = WagerTransaction.create(props);
    expect(bet.ledgerDirectionFor()).toBe('DEBIT');
    expect(bet.affectsBalance()).toBe(true);

    const win = WagerTransaction.create({ ...props, kind: WagerTransactionKind.Win });
    expect(win.ledgerDirectionFor()).toBe('CREDIT');

    const loss = WagerTransaction.create({ ...props, kind: WagerTransactionKind.Loss });
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(loss.affectsBalance()).toBe(false);

    const refund = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'external-bet',
    });
    expect(refund.ledgerDirectionFor()).toBe('CREDIT');
    expect(refund.requiresReference()).toBe(true);

    const rollback = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'external-bet',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
  });

  test('matches only the same canonical payload hash', () => {
    const transaction = WagerTransaction.create(props);
    expect(transaction.matchesPayload(props.payloadHash)).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });
});
