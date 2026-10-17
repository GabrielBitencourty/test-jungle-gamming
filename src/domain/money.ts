import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const DECIMAL_AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!CURRENCY.test(props.currency)) {
      throw new DomainError('Currency must be a three-letter ISO code', 'INVALID_CURRENCY');
    }
    if (!DECIMAL_AMOUNT.test(props.amount)) {
      throw new DomainError('Amount must be a non-negative decimal string with two places', 'INVALID_AMOUNT');
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static fromDecimal(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan('999999999999999999.99') || value.decimalPlaces() > 2) {
      throw new DomainError('Amount exceeds supported precision', 'AMOUNT_OUT_OF_RANGE');
    }
    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('Currency mismatch', 'CURRENCY_MISMATCH');
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.isPositive(); }
  isNegative(): boolean { return this.value.isNegative(); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }
}
