import { beforeEach, describe, expect, test } from 'bun:test';

import { WalletCreationStore } from '../ports/wallet-creation.store';
import type { OutboxMessageInput } from '../ports/wager-processing.store';
import { Wallet } from '../../domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { CreateWalletUseCase } from './create-wallet.use-case';

class FakeWalletCreationStore implements WalletCreationStore {
  readonly calls: Array<{
    wallet: Wallet;
    openingTransaction?: WagerTransaction;
    openingLedgerEntry?: WalletLedgerEntry;
    outboxMessages: OutboxMessageInput[];
  }> = [];

  async create(
    wallet: Wallet,
    openingTransaction?: WagerTransaction,
    openingLedgerEntry?: WalletLedgerEntry,
    outboxMessages: OutboxMessageInput[] = [],
  ): Promise<void> {
    this.calls.push({
      wallet,
      openingTransaction,
      openingLedgerEntry,
      outboxMessages,
    });
  }
}

describe('CreateWalletUseCase', () => {
  let store: FakeWalletCreationStore;
  let useCase: CreateWalletUseCase;

  beforeEach(() => {
    store = new FakeWalletCreationStore();
    useCase = new CreateWalletUseCase(store);
  });

  test('creates a zero-balance wallet without opening transaction or ledger', async () => {
    const wallet = await useCase.execute({
      playerId: 'player-1',
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    expect(wallet.playerId).toBe('player-1');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);

    expect(store.calls).toHaveLength(1);

    const call = store.calls[0];

    expect(call.openingTransaction).toBeUndefined();
    expect(call.openingLedgerEntry).toBeUndefined();
    expect(call.outboxMessages).toHaveLength(0);
  });

  test('creates opening transaction and credit ledger for a positive initial balance', async () => {
    const wallet = await useCase.execute({
      playerId: 'player-2',
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    expect(store.calls).toHaveLength(1);

    const call = store.calls[0];

    expect(call.wallet.id).toBe(wallet.id);
    expect(call.openingTransaction).toBeDefined();
    expect(call.openingLedgerEntry).toBeDefined();

    const openingTransaction = call.openingTransaction!;
    const openingLedgerEntry = call.openingLedgerEntry!;

    expect(openingTransaction.kind).toBe(
      WagerTransactionKind.Opening,
    );
    expect(openingTransaction.status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(openingTransaction.money.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(openingLedgerEntry.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(openingLedgerEntry.balanceBefore.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(openingLedgerEntry.balanceAfter.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(openingLedgerEntry.transactionId).toBe(
      openingTransaction.id,
    );
    expect(openingLedgerEntry.walletId).toBe(wallet.id);
    expect(openingLedgerEntry.isBalanced()).toBe(true);

    expect(call.outboxMessages).toHaveLength(2);
    expect(
      call.outboxMessages.map(
        (message) => message.eventType,
      ),
    ).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('does not persist a wallet with a negative initial balance', async () => {
    await expect(
      useCase.execute({
        playerId: 'player-3',
        initialBalance: {
          amount: '-10.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toThrow('Wallet initial balance cannot be negative');

    expect(store.calls).toHaveLength(0);
  });
});
