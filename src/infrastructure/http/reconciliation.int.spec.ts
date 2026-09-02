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
import { ProcessWagerUseCase } from '../../application/use-cases/process-wager.use-case';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';
import mikroOrmConfig from '../../mikro-orm.config';
import { ObservabilityService } from '../observability/observability.service';
import { MikroOrmWagerProcessingStore } from '../persistence/repositories/mikro-orm-wager-processing.store';
import { MikroOrmWalletCreationStore } from '../persistence/repositories/mikro-orm-wallet-creation.store';
import { ApiController } from './api.controller';

describe('Wallet reconciliation integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('reconstructs the materialized wallet balance exactly from the ledger', async () => {
    const createWallet = new CreateWalletUseCase(
      new MikroOrmWalletCreationStore(orm.em.fork()),
    );

    const processWager = new ProcessWagerUseCase(
      new MikroOrmWagerProcessingStore(orm.em.fork()),
    );

    const playerId = randomUUID();

    const wallet = await createWallet.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const roundId = randomUUID();

    await processWager.execute({
      idempotencyKey: randomUUID(),
      providerId: 'provider-reconciliation',
      externalTransactionId: randomUUID(),
      walletId: wallet.id,
      playerId,
      roundId,
      gameId: 'game-reconciliation',
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      currency: 'BRL',
    });

    await processWager.execute({
      idempotencyKey: randomUUID(),
      providerId: 'provider-reconciliation',
      externalTransactionId: randomUUID(),
      walletId: wallet.id,
      playerId,
      roundId,
      gameId: 'game-reconciliation',
      kind: WagerTransactionKind.Win,
      amount: '10.00',
      currency: 'BRL',
    });

    const observability = new ObservabilityService();

    const controller = new ApiController(
      orm.em.fork(),
      createWallet,
      processWager,
      observability,
    );

    const result = await controller.reconcile(wallet.id);

    expect(result).toEqual({
      walletId: wallet.id,
      storedBalance: {
        amount: '85.00',
        currency: 'BRL',
      },
      calculatedBalance: {
        amount: '85.00',
        currency: 'BRL',
      },
      difference: {
        amount: '0.00',
        currency: 'BRL',
      },
      consistent: true,
      checkedEntries: 3,
    });

    expect(
      observability.processMetrics()
        .reconciliationDivergences,
    ).toBe(0);
  });
});
