import { describe, expect, it } from 'bun:test';
import { Money } from './money';

describe('Money', () => {
  it('creates money from a valid decimal string', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('creates zero money for a currency', () => {
    const money = Money.zero('BRL');
    expect(money.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('adds money with the same currency', () => {
    const first = Money.from({ amount: '25.00', currency: 'BRL' });
    const second = Money.from({ amount: '10.50', currency: 'BRL' });
    expect(first.add(second).toJSON()).toEqual({ amount: '35.50', currency: 'BRL' });
  });

  it('subtracts money with the same currency', () => {
    const first = Money.from({ amount: '25.00', currency: 'BRL' });
    const second = Money.from({ amount: '10.50', currency: 'BRL' });
    expect(first.subtract(second).toJSON()).toEqual({ amount: '14.50', currency: 'BRL' });
  });

  it('does not mutate the original value during arithmetic', () => {
    const original = Money.from({ amount: '25.00', currency: 'BRL' });
    const result = original.add(Money.from({ amount: '10.00', currency: 'BRL' }));
    expect(original.toJSON().amount).toBe('25.00');
    expect(result.toJSON().amount).toBe('35.00');
  });

  it('rejects arithmetic between different currencies', () => {
    const brl = Money.from({ amount: '25.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow();
    expect(() => brl.subtract(usd)).toThrow();
  });

  it('rejects invalid monetary formats', () => {
    const invalidAmounts = ['', 'NaN', 'Infinity', '1e3', '25', '25.0', '25.000', 'abc'];
    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    }
  });

  it('preserves precision for large monetary values', () => {
    const first = Money.from({ amount: '999999999999999999999999.99', currency: 'BRL' });
    const second = Money.from({ amount: '0.01', currency: 'BRL' });
    expect(first.add(second).toJSON().amount).toBe('1000000000000000000000000.00');
  });

  it('negates a monetary value', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.negate().toJSON()).toEqual({ amount: '-25.00', currency: 'BRL' });
    expect(money.toJSON().amount).toBe('25.00');
  });

  it('identifies zero, positive and negative values', () => {
    const zero = Money.from({ amount: '0.00', currency: 'BRL' });
    const positive = Money.from({ amount: '10.00', currency: 'BRL' });
    const negative = Money.from({ amount: '-10.00', currency: 'BRL' });

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isNegative()).toBe(false);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
  });

  it('compares monetary values with the same currency', () => {
    const smaller = Money.from({ amount: '10.00', currency: 'BRL' });
    const greater = Money.from({ amount: '20.00', currency: 'BRL' });

    expect(smaller.isLessThan(greater)).toBe(true);
    expect(greater.isLessThan(smaller)).toBe(false);
    expect(smaller.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
  });

  it('does not consider different currencies equal', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(brl.equals(usd)).toBe(false);
  });

  it('rejects comparison between different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '20.00', currency: 'USD' });
    expect(() => brl.isLessThan(usd)).toThrow();
  });

  it('rejects invalid currency codes', () => {
    const invalidCurrencies = ['', 'BR', 'BRLL', 'brl', '123'];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: '10.00', currency })).toThrow();
    }
  });
});
