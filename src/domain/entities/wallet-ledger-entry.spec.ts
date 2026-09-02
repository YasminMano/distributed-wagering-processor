import { describe, expect, it } from 'bun:test';
import { Money } from '../value-objects/money';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit entry', () => {
    const createdAt = new Date('2026-09-02T12:00:00.000Z');

    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
      balanceBefore: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
      balanceAfter: Money.from({
        amount: '75.00',
        currency: 'BRL',
      }),
      createdAt,
    });

    expect(entry.id).toBe('ledger-1');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(entry.balanceBefore.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(entry.balanceAfter.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(entry.createdAt).toEqual(createdAt);
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced credit entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Credit,
      money: Money.from({
        amount: '40.00',
        currency: 'BRL',
      }),
      balanceBefore: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
      balanceAfter: Money.from({
        amount: '140.00',
        currency: 'BRL',
      }),
      createdAt: new Date('2026-09-02T12:00:00.000Z'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a debit whose arithmetic does not match the balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money: Money.from({
          amount: '25.00',
          currency: 'BRL',
        }),
        balanceBefore: Money.from({
          amount: '100.00',
          currency: 'BRL',
        }),
        balanceAfter: Money.from({
          amount: '80.00',
          currency: 'BRL',
        }),
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      }),
    ).toThrow();
  });

  it('rejects a credit whose arithmetic does not match the balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Credit,
        money: Money.from({
          amount: '25.00',
          currency: 'BRL',
        }),
        balanceBefore: Money.from({
          amount: '100.00',
          currency: 'BRL',
        }),
        balanceAfter: Money.from({
          amount: '120.00',
          currency: 'BRL',
        }),
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      }),
    ).toThrow();
  });

  it('rejects zero or negative movement amounts', () => {
    const balance = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-zero',
        walletId: 'wallet-1',
        transactionId: 'transaction-zero',
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: balance,
        balanceAfter: balance,
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      }),
    ).toThrow();

    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-negative',
        walletId: 'wallet-1',
        transactionId: 'transaction-negative',
        direction: LedgerDirection.Debit,
        money: Money.from({
          amount: '-10.00',
          currency: 'BRL',
        }),
        balanceBefore: balance,
        balanceAfter: Money.from({
          amount: '110.00',
          currency: 'BRL',
        }),
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      }),
    ).toThrow();
  });

  it('rejects entries with inconsistent currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money: Money.from({
          amount: '25.00',
          currency: 'USD',
        }),
        balanceBefore: Money.from({
          amount: '100.00',
          currency: 'BRL',
        }),
        balanceAfter: Money.from({
          amount: '75.00',
          currency: 'BRL',
        }),
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      }),
    ).toThrow();
  });

  it('rehydrates persisted state without replaying creation validation', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
      balanceBefore: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
      balanceAfter: Money.from({
        amount: '90.00',
        currency: 'BRL',
      }),
      createdAt: new Date('2026-09-02T12:00:00.000Z'),
    });

    expect(entry.isBalanced()).toBe(false);
  });

  it('protects the creation timestamp from external mutation', () => {
    const createdAt = new Date('2026-09-02T12:00:00.000Z');

    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Credit,
      money: Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
      balanceBefore: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
      balanceAfter: Money.from({
        amount: '110.00',
        currency: 'BRL',
      }),
      createdAt,
    });

    createdAt.setUTCFullYear(2030);

    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(2040);

    expect(entry.createdAt).toEqual(
      new Date('2026-09-02T12:00:00.000Z'),
    );
  });
});
