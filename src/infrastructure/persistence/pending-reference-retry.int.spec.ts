import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import {
  ProcessWagerUseCase,
  WagerFailureCode,
} from '../../application/use-cases/process-wager.use-case';
import { RetryPendingReferenceWagersUseCase } from '../../application/use-cases/retry-pending-reference-wagers.use-case';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import mikroOrmConfig from '../../mikro-orm.config';
import { WagerTransactionPersistence } from './entities/wager-transaction.persistence';
import { WalletLedgerEntryPersistence } from './entities/wallet-ledger-entry.persistence';
import { WalletPersistence } from './entities/wallet.persistence';
import { MikroOrmWagerProcessingStore } from './repositories/mikro-orm-wager-processing.store';
import { MikroOrmWalletCreationStore } from './repositories/mikro-orm-wallet-creation.store';

describe('Pending reference retry integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function createPendingRefund() {
    const playerId = randomUUID();

    const wallet = await new CreateWalletUseCase(
      new MikroOrmWalletCreationStore(orm.em.fork()),
    ).execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const providerId = `provider-pending-${randomUUID()}`;
    const roundId = randomUUID();
    const betExternalTransactionId = randomUUID();

    const refund = await new ProcessWagerUseCase(
      new MikroOrmWagerProcessingStore(orm.em.fork()),
    ).execute({
      idempotencyKey: randomUUID(),
      providerId,
      externalTransactionId: randomUUID(),
      walletId: wallet.id,
      playerId,
      roundId,
      gameId: 'game-pending-reference',
      kind: WagerTransactionKind.Refund,
      amount: '80.00',
      currency: 'BRL',
      referenceExternalTransactionId:
        betExternalTransactionId,
    });

    return {
      playerId,
      wallet,
      providerId,
      roundId,
      betExternalTransactionId,
      refund,
    };
  }

  type PendingScenario =
    Awaited<ReturnType<typeof createPendingRefund>>;

  async function processReferencedBet(
    scenario: PendingScenario,
  ): Promise<void> {
    await new ProcessWagerUseCase(
      new MikroOrmWagerProcessingStore(orm.em.fork()),
    ).execute({
      idempotencyKey: randomUUID(),
      providerId: scenario.providerId,
      externalTransactionId:
        scenario.betExternalTransactionId,
      walletId: scenario.wallet.id,
      playerId: scenario.playerId,
      roundId: scenario.roundId,
      gameId: 'game-pending-reference',
      kind: WagerTransactionKind.Bet,
      amount: '80.00',
      currency: 'BRL',
    });
  }

  async function loadTransaction(id: string){
    const transaction = await orm.em
      .fork()
      .findOne(WagerTransactionPersistence, { id });

    if (!transaction) {
      throw new Error(`Transaction ${id} was not found`);
    }

    return transaction;
  }

  function afterRetryTime(
    nextRetryAt: Date | null | undefined,
  ): Date {
    if (!nextRetryAt) {
      throw new Error('Expected a next retry timestamp');
    }

    return new Date(nextRetryAt.getTime() + 1);
  }

  function createRetryUseCase(): RetryPendingReferenceWagersUseCase {
    return new RetryPendingReferenceWagersUseCase(
      new MikroOrmWagerProcessingStore(orm.em.fork()),
    );
  }

  test('processes the same REFUND after its BET arrives later', async () => {
    const scenario = await createPendingRefund();

    expect(scenario.refund.transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    const originalRefundId =
      scenario.refund.transaction.id;

    const persistedPending =
      await loadTransaction(originalRefundId);

    expect(persistedPending.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(persistedPending.retryAttempts).toBe(0);

    const retryAt = afterRetryTime(
      persistedPending.nextRetryAt,
    );

    /*
     * A BET chega depois do REFUND.
     */
    await processReferencedBet(scenario);

    /*
     * O worker encontra o REFUND pendente e deve atualizar
     * a MESMA transação.
     */
    await createRetryUseCase().processDue(retryAt);

    const verificationEm = orm.em.fork();

    const processedRefund =
      await verificationEm.findOneOrFail(
        WagerTransactionPersistence,
        { id: originalRefundId },
      );

    const wallet = await verificationEm.findOneOrFail(
      WalletPersistence,
      { id: scenario.wallet.id },
    );

    const refundTransactions =
      await verificationEm.find(
        WagerTransactionPersistence,
        {
          wallet: scenario.wallet.id,
          kind: WagerTransactionKind.Refund,
        },
      );

    const refundLedger =
      await verificationEm.find(
        WalletLedgerEntryPersistence,
        {
          wallet: scenario.wallet.id,
          transaction: originalRefundId,
        },
      );

    expect(processedRefund.id).toBe(originalRefundId);
    expect(processedRefund.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(refundTransactions).toHaveLength(1);

    /*
     * OPENING: version 1
     * BET:     version 2
     * REFUND:  version 3
     */
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(3);

    expect(refundLedger).toHaveLength(1);
    expect(refundLedger[0].direction).toBe('CREDIT');
    expect(refundLedger[0].amount).toBe('80.00');
    expect(refundLedger[0].balanceBefore).toBe('20.00');
    expect(refundLedger[0].balanceAfter).toBe('100.00');

    /*
     * Executar novamente o worker não pode repetir
     * o efeito financeiro.
     */
    await createRetryUseCase().processDue(
      new Date(retryAt.getTime() + 60_000),
    );

    const finalEm = orm.em.fork();

    const finalLedger =
      await finalEm.find(
        WalletLedgerEntryPersistence,
        {
          wallet: scenario.wallet.id,
          transaction: originalRefundId,
        },
      );

    const finalWallet =
      await finalEm.findOneOrFail(
        WalletPersistence,
        { id: scenario.wallet.id },
      );

    expect(finalLedger).toHaveLength(1);
    expect(finalWallet.balance).toBe('100.00');
    expect(finalWallet.version).toBe(3);
  });

  test('rejects a pending reversal after five missing-reference retries', async () => {
    const scenario = await createPendingRefund();

    const refundId =
      scenario.refund.transaction.id;

    /*
     * A referência nunca será criada.
     *
     * Avançamos o relógio artificialmente para nextRetryAt
     * em vez de usar sleep real.
     */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current =
        await loadTransaction(refundId);

      expect(current.status).toBe(
        WagerTransactionStatus.PendingReference,
      );

      const retryAt = afterRetryTime(
        current.nextRetryAt,
      );

      await createRetryUseCase().processDue(retryAt);
    }

    const verificationEm = orm.em.fork();

    const rejected =
      await verificationEm.findOneOrFail(
        WagerTransactionPersistence,
        { id: refundId },
      );

    const wallet =
      await verificationEm.findOneOrFail(
        WalletPersistence,
        { id: scenario.wallet.id },
      );

    const refundLedger =
      await verificationEm.find(
        WalletLedgerEntryPersistence,
        {
          wallet: scenario.wallet.id,
          transaction: refundId,
        },
      );

    expect(rejected.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(rejected.failureCode).toBe(
      WagerFailureCode.ReferenceNotFound,
    );

    /*
     * Estado terminal não fica agendado novamente.
     */
    expect(rejected.nextRetryAt ?? null).toBeNull();

    /*
     * O REFUND nunca chegou a afetar a wallet.
     */
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(refundLedger).toHaveLength(0);

    /*
     * Outra execução do worker não pode alterar
     * uma transação terminal.
     */
    await createRetryUseCase().processDue(
      new Date(Date.now() + 86_400_000),
    );

    const finalState =
      await loadTransaction(refundId);

    expect(finalState.status).toBe(
      WagerTransactionStatus.Rejected,
    );
    expect(finalState.failureCode).toBe(
      WagerFailureCode.ReferenceNotFound,
    );
  });

  test('serializes concurrent workers retrying the same REFUND', async () => {
    const scenario = await createPendingRefund();

    const refundId =
      scenario.refund.transaction.id;

    const pending =
      await loadTransaction(refundId);

    const retryAt = afterRetryTime(
      pending.nextRetryAt,
    );

    /*
     * A referência aparece antes dos dois workers.
     */
    await processReferencedBet(scenario);

    /*
     * Stores e EntityManagers separados simulam workers
     * em instâncias diferentes.
     */
    const workerA = createRetryUseCase();
    const workerB = createRetryUseCase();

    await Promise.all([
      workerA.processDue(retryAt),
      workerB.processDue(retryAt),
    ]);

    const verificationEm = orm.em.fork();

    const processedRefund =
      await verificationEm.findOneOrFail(
        WagerTransactionPersistence,
        { id: refundId },
      );

    const wallet =
      await verificationEm.findOneOrFail(
        WalletPersistence,
        { id: scenario.wallet.id },
      );

    const refundTransactions =
      await verificationEm.find(
        WagerTransactionPersistence,
        {
          wallet: scenario.wallet.id,
          kind: WagerTransactionKind.Refund,
        },
      );

    const refundLedger =
      await verificationEm.find(
        WalletLedgerEntryPersistence,
        {
          wallet: scenario.wallet.id,
          transaction: refundId,
        },
      );

    expect(processedRefund.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(refundTransactions).toHaveLength(1);

    /*
     * Mesmo com dois workers:
     * BET debita uma vez e REFUND credita uma vez.
     */
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe(3);

    expect(refundLedger).toHaveLength(1);
    expect(refundLedger[0].direction).toBe('CREDIT');
    expect(refundLedger[0].amount).toBe('80.00');
  });
});
