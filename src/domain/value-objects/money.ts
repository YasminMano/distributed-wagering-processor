import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MoneyDecimal = Decimal.clone({
  precision: 100,
});

export class Money {
  private static readonly AMOUNT_PATTERN = /^-?\d+\.\d{2}$/;
  private static readonly CURRENCY_PATTERN = /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    Money.validateAmount(props.amount);
    Money.validateCurrency(props.currency);

    const value = new MoneyDecimal(props.amount);

    if (!value.isFinite()) {
      throw new Error('Money amount must be finite');
    }

    return new Money(value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.from({
      amount: this.value.plus(other.value).toFixed(2),
      currency: this.currency,
    });
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.from({
      amount: this.value.minus(other.value).toFixed(2),
      currency: this.currency,
    });
  }

  negate(): Money {
    return Money.from({
      amount: this.value.negated().toFixed(2),
      currency: this.currency,
    });
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.value.equals(other.value)
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  private static validateAmount(amount: string): void {
    if (!Money.AMOUNT_PATTERN.test(amount)) {
      throw new Error(
        'Money amount must be a decimal string with exactly two decimal places',
      );
    }
  }

  private static validateCurrency(currency: string): void {
    if (!Money.CURRENCY_PATTERN.test(currency)) {
      throw new Error(
        'Money currency must be a three-letter uppercase code',
      );
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
      );
    }
  }
}
