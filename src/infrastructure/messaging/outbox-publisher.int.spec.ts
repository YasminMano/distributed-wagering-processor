import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  PurgeQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../mikro-orm.config';
import { ObservabilityService } from '../observability/observability.service';
import { OutboxMessagePersistence } from '../persistence/entities/outbox-message.persistence';
import { OutboxPublisherWorker } from './outbox-publisher.worker';

describe('Outbox publisher integration', () => {
  let orm: MikroORM;
  let sqs: SQSClient;

  const queueUrl =
    process.env.SQS_EVENT_QUEUE_URL ??
    'http://localhost:4566/000000000000/wager-events.fifo';

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();

    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint:
        process.env.SQS_ENDPOINT ??
        'http://localhost:4566',
      credentials: {
        accessKeyId:
          process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });

    await sqs.send(
      new PurgeQueueCommand({
        QueueUrl: queueUrl,
      }),
    );
  });

  afterAll(async () => {
    await sqs.send(
      new PurgeQueueCommand({
        QueueUrl: queueUrl,
      }),
    );

    sqs.destroy();
    await orm.close(true);
  });

  test('allows two publishers to claim the same outbox concurrently without double publication', async () => {
    const setupEm = orm.em.fork();

    const messages = Array.from(
      { length: 50 },
      (_, index) => ({
        id: randomUUID(),
        aggregateId: randomUUID(),
        eventType: 'OutboxConcurrencyTest',
        payload: {
          eventId: randomUUID(),
          eventType: 'OutboxConcurrencyTest',
          sequence: index,
        },
        occurredAt: new Date(),
        attempts: 0,
        nextAttemptAt: null,
        publishedAt: null,
      }),
    );

    await setupEm.insertMany(
      OutboxMessagePersistence,
      messages,
    );

    const observability =
      new ObservabilityService();

    const publisherA = new OutboxPublisherWorker(
      orm.em.fork(),
      observability,
    );

    const publisherB = new OutboxPublisherWorker(
      orm.em.fork(),
      observability,
    );

    /*
     * Cada publisher pode pegar no máximo 20 linhas.
     * Com 50 mensagens disponíveis, os dois precisam
     * efetivamente publicar trabalho na primeira rodada.
     */
    const [processedByA, processedByB] =
      await Promise.all([
        publisherA.publishBatch(),
        publisherB.publishBatch(),
      ]);

    expect(processedByA).toBeGreaterThan(0);
    expect(processedByB).toBeGreaterThan(0);
    expect(processedByA + processedByB).toBe(40);

    /*
     * Restam 10 linhas. Uma segunda rodada concorrente
     * conclui o restante.
     */
    await Promise.all([
      publisherA.publishBatch(),
      publisherB.publishBatch(),
    ]);

    const verificationEm = orm.em.fork();

    const persisted =
      await verificationEm.find(
        OutboxMessagePersistence,
        {
          id: {
            $in: messages.map(
              (message) => message.id,
            ),
          },
        },
      );

    expect(persisted).toHaveLength(50);

    expect(
      persisted.every(
        (message) =>
          message.publishedAt !== null,
      ),
    ).toBe(true);

    /*
     * attempts = 1 prova que cada linha foi enviada
     * exatamente uma vez pelos publishers concorrentes.
     */
    expect(
      persisted.every(
        (message) => message.attempts === 1,
      ),
    ).toBe(true);

    await verificationEm.nativeDelete(
      OutboxMessagePersistence,
      {
        id: {
          $in: messages.map(
            (message) => message.id,
          ),
        },
      },
    );
  });
});
