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
import {
  ProcessWagerUseCase,
  WagerFailureCode,
} from '../../../application/use-cases/process-wager.use-case';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import mikroOrmConfig from '../../../mikro-orm.config';
import { WagerTransactionPersistence } from '../entities/wager-transaction.persistence';
import { WalletLedgerEntryPersistence } from '../entities/wallet-ledger-entry.persistence';
import { WalletPersistence } from '../entities/wallet.persistence';
import { MikroOrmWalletCreationStore } from './mikro-orm-wallet-creation.store';
import { MikroOrmWagerProcessingStore } from './mikro-orm-wager-processing.store';

describe('MikroOrmWagerProcessingStore integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('serializes concurrent BETs for the same wallet', async () => {
    /*
     * A criação precisa ser commitada antes das duas transações
     * concorrentes, para que ambas consigam enxergar a wallet.
     */
    const creationEm = orm.em.fork();

    const createWalletUseCase = new CreateWalletUseCase(
      new MikroOrmWalletCreationStore(creationEm),
    );

    const playerId = randomUUID();

    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    /*
     * Dois EntityManagers independentes simulam duas requisições
     * ou até duas instâncias diferentes da aplicação.
     */
    const processorA = new ProcessWagerUseCase(
      new MikroOrmWagerProcessingStore(
        orm.em.fork(),
      ),
    );

    const processorB = new ProcessWagerUseCase(
      new MikroOrmWagerProcessingStore(
        orm.em.fork(),
      ),
    );

    const baseInput = {
      providerId: 'provider-concurrency',
      walletId: wallet.id,
      playerId,
      roundId: randomUUID(),
      gameId: 'game-concurrency',
      kind: WagerTransactionKind.Bet,
      amount: '80.00',
      currency: 'BRL',
    };

    const [resultA, resultB] = await Promise.all([
      processorA.execute({
        ...baseInput,
        idempotencyKey: randomUUID(),
        externalTransactionId: randomUUID(),
      }),
      processorB.execute({
        ...baseInput,
        idempotencyKey: randomUUID(),
        externalTransactionId: randomUUID(),
      }),
    ]);

    const results = [resultA, resultB];

    const processed = results.filter(
      (result) =>
        result.transaction.status ===
        WagerTransactionStatus.Processed,
    );

    const rejected = results.filter(
      (result) =>
        result.transaction.status ===
        WagerTransactionStatus.Rejected,
    );

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(rejected[0].transaction.failureCode).toBe(
      WagerFailureCode.InsufficientFunds,
    );

    /*
     * Novo EntityManager para verificar o estado realmente
     * commitado, sem qualquer objeto vindo do identity map
     * das transações anteriores.
     */
    const verificationEm = orm.em.fork();

    const persistedWallet = await verificationEm.findOne(
      WalletPersistence,
      {
        id: wallet.id,
      },
    );

    expect(persistedWallet).not.toBeNull();
    expect(persistedWallet?.balance).toBe('20.00');
    expect(persistedWallet?.version).toBe(2);

    const betTransactions = await verificationEm.find(
      WagerTransactionPersistence,
      {
        wallet: wallet.id,
        kind: WagerTransactionKind.Bet,
      },
    );

    expect(betTransactions).toHaveLength(2);

    expect(
      betTransactions.filter(
        (transaction) =>
          transaction.status ===
          WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);

    expect(
      betTransactions.filter(
        (transaction) =>
          transaction.status ===
          WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);

    const debitEntries = await verificationEm.find(
      WalletLedgerEntryPersistence,
      {
        wallet: wallet.id,
        direction: 'DEBIT',
      },
    );

    expect(debitEntries).toHaveLength(1);
    expect(debitEntries[0].amount).toBe('80.00');
    expect(debitEntries[0].balanceBefore).toBe('100.00');
    expect(debitEntries[0].balanceAfter).toBe('20.00');
  });
});
