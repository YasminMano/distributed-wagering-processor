import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import {
  ProcessWagerUseCase,
  WalletNotFoundError,
} from '../../application/use-cases/process-wager.use-case';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';

import mikroOrmConfig from '../../mikro-orm.config';
import { InboxMessagePersistence } from './entities/inbox-message.persistence';
import { MikroOrmWagerProcessingStore } from './repositories/mikro-orm-wager-processing.store';

describe('Inbox persistence integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('deduplicates the same SQS message persistently', async () => {
    const consumerName = 'wager-transactions-consumer';
    const messageId = randomUUID();
    const payloadHash = 'a'.repeat(64);

    const firstStore = new MikroOrmWagerProcessingStore(
      orm.em.fork(),
    );

    const first = await firstStore.execute(
      async (unitOfWork) => {
        const claim = await unitOfWork.claimInboxMessage({
          consumerName,
          messageId,
          payloadHash,
          receivedAt: new Date(),
        });

        expect(claim).toBe('CLAIMED');

        await unitOfWork.markInboxMessageProcessed(
          consumerName,
          messageId,
          new Date(),
        );

        return claim;
      },
    );

    expect(first).toBe('CLAIMED');

    /*
     * Outro EntityManager simula redelivery em outra
     * execução ou outra instância da aplicação.
     */
    const duplicateStore =
      new MikroOrmWagerProcessingStore(orm.em.fork());

    const duplicate = await duplicateStore.execute(
      (unitOfWork) =>
        unitOfWork.claimInboxMessage({
          consumerName,
          messageId,
          payloadHash,
          receivedAt: new Date(),
        }),
    );

    expect(duplicate).toBe('DUPLICATE');

    const verificationEm = orm.em.fork();

    const rows = await verificationEm.find(
      InboxMessagePersistence,
      {
        consumerName,
        messageId,
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].payloadHash).toBe(payloadHash);
    expect(rows[0].processedAt).not.toBeNull();
  });

  test('detects the same message id with a different payload', async () => {
    const consumerName = 'wager-transactions-consumer';
    const messageId = randomUUID();

    const store = new MikroOrmWagerProcessingStore(
      orm.em.fork(),
    );

    const first = await store.execute((unitOfWork) =>
      unitOfWork.claimInboxMessage({
        consumerName,
        messageId,
        payloadHash: 'b'.repeat(64),
        receivedAt: new Date(),
      }),
    );

    expect(first).toBe('CLAIMED');

    const conflictingStore =
      new MikroOrmWagerProcessingStore(orm.em.fork());

    const conflict = await conflictingStore.execute(
      (unitOfWork) =>
        unitOfWork.claimInboxMessage({
          consumerName,
          messageId,
          payloadHash: 'c'.repeat(64),
          receivedAt: new Date(),
        }),
    );

    expect(conflict).toBe('CONFLICT');

    const rows = await orm.em.fork().find(
      InboxMessagePersistence,
      {
        consumerName,
        messageId,
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].payloadHash).toBe('b'.repeat(64));
  });
  test('rolls back inbox claim when financial processing fails', async () => {
    const consumerName = 'wager-transactions-consumer';
    const messageId = randomUUID();

    const processor = new ProcessWagerUseCase(
      new MikroOrmWagerProcessingStore(orm.em.fork()),
    );

    await expect(
      processor.executeFromInbox(
        {
          idempotencyKey: randomUUID(),
          providerId: 'provider-rollback-test',
          externalTransactionId: randomUUID(),
          walletId: randomUUID(),
          playerId: randomUUID(),
          roundId: randomUUID(),
          gameId: 'game-rollback-test',
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
          currency: 'BRL',
        },
        {
          consumerName,
          messageId,
          payloadHash: 'd'.repeat(64),
          receivedAt: new Date(),
        },
      ),
    ).rejects.toBeInstanceOf(WalletNotFoundError);

    const inbox = await orm.em.fork().findOne(
      InboxMessagePersistence,
      {
        consumerName,
        messageId,
      },
    );

    expect(inbox).toBeNull();
  });

});
