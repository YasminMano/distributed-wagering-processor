import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { Wallet } from '../../../domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../domain/entities/wager-transaction';
import { Money } from '../../../domain/value-objects/money';
import mikroOrmConfig from '../../../mikro-orm.config';
import { WalletLedgerEntryPersistence } from '../entities/wallet-ledger-entry.persistence';
import { WagerTransactionPersistence } from '../entities/wager-transaction.persistence';
import { WalletPersistence } from '../entities/wallet.persistence';
import { MikroOrmWalletCreationStore } from './mikro-orm-wallet-creation.store';

describe('MikroOrmWalletCreationStore integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('persists wallet, OPENING transaction and ledger atomically', async () => {
    const em = orm.em.fork();

    await em.begin();

    try {
      const store = new MikroOrmWalletCreationStore(em);
      const useCase = new CreateWalletUseCase(store);

      const wallet = await useCase.execute({
        playerId: randomUUID(),
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      });

      em.clear();

      const persistedWallet = await em.findOne(
        WalletPersistence,
        {
          id: wallet.id,
        },
      );

      const openingTransaction = await em.findOne(
        WagerTransactionPersistence,
        {
          wallet: wallet.id,
          kind: WagerTransactionKind.Opening,
        },
      );

      const ledgerEntry = await em.findOne(
        WalletLedgerEntryPersistence,
        {
          wallet: wallet.id,
        },
      );

      expect(persistedWallet).not.toBeNull();
      expect(persistedWallet?.balance).toBe('100.00');

      expect(openingTransaction).not.toBeNull();
      expect(openingTransaction?.status).toBe('PROCESSED');
      expect(openingTransaction?.amount).toBe('100.00');

      expect(ledgerEntry).not.toBeNull();
      expect(ledgerEntry?.direction).toBe('CREDIT');
      expect(ledgerEntry?.balanceBefore).toBe('0.00');
      expect(ledgerEntry?.balanceAfter).toBe('100.00');
    } finally {
      await em.rollback();
    }
  });

  test('rolls back wallet and transaction when ledger persistence fails', async () => {
    const em = orm.em.fork();

    await em.begin();

    try {
      const store = new MikroOrmWalletCreationStore(em);

      const walletId = randomUUID();
      const playerId = randomUUID();
      const transactionId = randomUUID();
      const balance = Money.from({
        amount: '50.00',
        currency: 'BRL',
      });

      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: balance,
      });

      const now = new Date();

      const openingTransaction = WagerTransaction.create({
        id: transactionId,
        providerId: 'internal',
        externalTransactionId: `opening:${walletId}`,
        idempotencyKey: `internal:opening:${walletId}`,
        payloadHash: 'a'.repeat(64),
        walletId,
        playerId,
        roundId: `opening:${walletId}`,
        gameId: 'wallet-opening',
        kind: WagerTransactionKind.Opening,
        money: balance,
        createdAt: now,
      });

      openingTransaction.markProcessed(undefined, now);

      const invalidLedgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),

        // propositalmente aponta para uma wallet inexistente
        walletId: randomUUID(),

        transactionId,
        direction: LedgerDirection.Credit,
        money: balance,
        balanceBefore: Money.zero('BRL'),
        balanceAfter: balance,
        createdAt: now,
      });

      await expect(
        store.create(
          wallet,
          openingTransaction,
          invalidLedgerEntry,
        ),
      ).rejects.toThrow();

      em.clear();

      const persistedWallet = await em.findOne(
        WalletPersistence,
        {
          id: walletId,
        },
      );

      const persistedTransaction = await em.findOne(
        WagerTransactionPersistence,
        {
          id: transactionId,
        },
      );

      expect(persistedWallet).toBeNull();
      expect(persistedTransaction).toBeNull();
    } finally {
      await em.rollback();
    }
  });
});
