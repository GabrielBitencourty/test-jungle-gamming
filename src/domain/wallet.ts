import { DomainError, Money } from './money';

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private currentBalance: Money,
    private currentVersion: number,
    readonly createdAt: Date,
    private currentUpdatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('Initial balance cannot be negative', 'INVALID_INITIAL_BALANCE');
    }
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, new Date(), new Date());
  }

  static rehydrate(state: {
    id: string; playerId: string; currency: string; balance: Money;
    version: number; createdAt: Date; updatedAt: Date;
  }): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money { return this.currentBalance; }
  get version(): number { return this.currentVersion; }
  get updatedAt(): Date { return this.currentUpdatedAt; }

  debit(amount: Money, at = new Date()): void {
    this.assertCurrency(amount);
    if (amount.isNegative() || amount.isZero()) {
      throw new DomainError('Debit amount must be positive', 'INVALID_AMOUNT');
    }
    if (this.currentBalance.isLessThan(amount)) {
      throw new DomainError('Insufficient funds', 'INSUFFICIENT_FUNDS');
    }
    this.change(this.currentBalance.subtract(amount), at);
  }

  credit(amount: Money, at = new Date()): void {
    this.assertCurrency(amount);
    if (!amount.isPositive()) {
      throw new DomainError('Credit must be positive', 'INVALID_AMOUNT');
    }
    this.change(this.currentBalance.add(amount), at);
  }

  private change(balance: Money, at: Date): void {
    this.currentBalance = balance;
    this.currentVersion += 1;
    this.currentUpdatedAt = at;
  }

  private assertCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError('Currency mismatch', 'CURRENCY_MISMATCH');
    }
  }
}
