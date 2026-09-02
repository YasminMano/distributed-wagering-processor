import { describe, expect, it } from 'bun:test';
import { Money } from '../value-objects/money';
import { Wallet } from './wallet';

describe('Wallet', () => {
  it('opens a wallet with the initial balance and version 1', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('allows a wallet to open with zero balance', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('credits the wallet and increments the version', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    wallet.credit(
      Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(2);
  });

  it('debits the wallet and increments the version', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    wallet.debit(
      Money.from({
        amount: '30.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toJSON()).toEqual({
      amount: '70.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(2);
  });

  it('allows a debit equal to the full balance', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    wallet.debit(
      Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(2);
  });

  it('rejects a debit that would make the balance negative', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    expect(() =>
      wallet.debit(
        Money.from({
          amount: '120.00',
          currency: 'BRL',
        }),
      ),
    ).toThrow();

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('rejects movements in a different currency', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    expect(() =>
      wallet.credit(
        Money.from({
          amount: '10.00',
          currency: 'USD',
        }),
      ),
    ).toThrow();

    expect(() =>
      wallet.debit(
        Money.from({
          amount: '10.00',
          currency: 'USD',
        }),
      ),
    ).toThrow();

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.from({
          amount: '-1.00',
          currency: 'BRL',
        }),
      }),
    ).toThrow();
  });

  it('rejects zero or negative credit and debit amounts', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    const zero = Money.from({
      amount: '0.00',
      currency: 'BRL',
    });

    const negative = Money.from({
      amount: '-10.00',
      currency: 'BRL',
    });

    expect(() => wallet.credit(zero)).toThrow();
    expect(() => wallet.debit(zero)).toThrow();
    expect(() => wallet.credit(negative)).toThrow();
    expect(() => wallet.debit(negative)).toThrow();

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('rehydrates a persisted wallet without replaying transitions', () => {
    const createdAt = new Date('2026-09-01T12:00:00.000Z');
    const updatedAt = new Date('2026-09-01T13:00:00.000Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from({
        amount: '42.00',
        currency: 'BRL',
      }),
      version: 7,
      createdAt,
      updatedAt,
    });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '42.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });
});
