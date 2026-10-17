import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';

describe('Wallet', () => {
  test('changes balance and version on a successful debit', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
  });

  test('rejects overdraft and currency mismatch', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    expect(() => wallet.debit(Money.from({ amount: '11.00', currency: 'BRL' })))
      .toThrow('Insufficient funds');
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' })))
      .toThrow('Currency mismatch');
    expect(wallet.version).toBe(1);
  });

  test('does not allow a negative initial balance', () => {
    expect(() => Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }).negate(),
    })).toThrow('Initial balance cannot be negative');
  });
});
