import { describe, expect, test } from 'bun:test';
import { DomainError, Money } from './money';

describe('Money', () => {
  test('performs exact immutable arithmetic', () => {
    const first = Money.from({ amount: '10.10', currency: 'BRL' });
    const result = first.add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(result.toJSON()).toEqual({ amount: '10.30', currency: 'BRL' });
    expect(first.toJSON()).toEqual({ amount: '10.10', currency: 'BRL' });
    expect(result.subtract(first).toJSON().amount).toBe('0.20');
  });

  test('rejects malformed amounts and currencies', () => {
    for (const amount of ['', '1', '1.001', '1e2', '-1.00', 'NaN', '1000000000000000000.00']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(DomainError);
    }
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(DomainError);
  });

  test('rejects cross-currency operations', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'BRL' })
      .add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow('Currency mismatch');
  });

  test('preserves two decimal places and rejects arithmetic overflow', () => {
    const amount = Money.from({ amount: '0.10', currency: 'BRL' })
      .add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(amount.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(() => Money.from({ amount: '999999999999999999.99', currency: 'BRL' })
      .add(Money.from({ amount: '0.01', currency: 'BRL' }))).toThrow(DomainError);
  });
});
