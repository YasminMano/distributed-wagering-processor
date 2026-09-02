import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { ProcessWagerUseCase } from '../../application/use-cases/process-wager.use-case';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';
import mikroOrmConfig from '../../mikro-orm.config';
import { ObservabilityService } from '../observability/observability.service';
import { MikroOrmWagerProcessingStore } from '../persistence/repositories/mikro-orm-wager-processing.store';
import { MikroOrmWalletCreationStore } from '../persistence/repositories/mikro-orm-wallet-creation.store';
import { WagerTransactionsSqsConsumer } from './wager-transactions-sqs.consumer';

const CONSUMER_NAME = 'wager-transactions-consumer';

interface TestableConsumer {
  client: {
    send(command: unknown): Promise<unknown>;
    destroy(): void;
  };
  processMessage(message: Message): Promise<void>;
}

describe('SQS resilience integration', () => {
  let orm: MikroORM;
  let sqs: SQSClient;

  const queueUrl =
    process.env.SQS_WAGER_QUEUE_URL ??
    'http://localhost:4566/000000000000/wager-transactions.fifo';

  const dlqUrl =
    process.env.SQS_WAGER_DLQ_URL ??
    'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

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
  });

  beforeEach(async () => {
    await sqs.send(
      new PurgeQueueCommand({
        QueueUrl: queueUrl,
      }),
    );

    await sqs.send(
      new PurgeQueueCommand({
        QueueUrl: dlqUrl,
      }),
    );
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  test('reprocesses safely after financial commit when the worker crashes before SQS ACK', async () => {
    const createWallet = new CreateWalletUseCase(
      new MikroOrmWalletCreationStore(orm.em.fork()),
    );

    const playerId = randomUUID();

    const wallet = await createWallet.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const messageId = randomUUID();
    const idempotencyKey = randomUUID();
    const externalTransactionId = randomUUID();

    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs-crash',
        externalTransactionId,
        idempotencyKey,
        walletId: wallet.id,
        playerId,
        roundId: randomUUID(),
        gameId: 'game-sqs-crash',
        kind: WagerTransactionKind.Bet,
        money: {
          amount: '10.00',
          currency: 'BRL',
        },
      },
    };

    const body = JSON.stringify(envelope);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
      }),
    );

    const firstDelivery = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const firstMessage = firstDelivery.Messages?.[0];

    expect(firstMessage).toBeDefined();
    expect(firstMessage?.ReceiptHandle).toBeDefined();

    const crashingConsumer =
      new WagerTransactionsSqsConsumer(
        new ProcessWagerUseCase(
          new MikroOrmWagerProcessingStore(
            orm.em.fork(),
          ),
        ),
        new ObservabilityService(),
      );

    const crashHarness =
      crashingConsumer as unknown as TestableConsumer;

    crashHarness.client = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof DeleteMessageCommand) {
          throw new Error(
            'simulated crash after commit before ack',
          );
        }

        throw new Error(
          'unexpected SQS command in crash harness',
        );
      },
      destroy(): void {},
    };

    await expect(
      crashHarness.processMessage(firstMessage!),
    ).rejects.toThrow(
      'simulated crash after commit before ack',
    );

    /*
     * executeFromInbox() terminou antes do DeleteMessage:
     * wallet + transaction + ledger + inbox + outbox
     * já estão commitados quando o ACK falha.
     */
    const afterCrashEm = orm.em.fork();

    const afterCrashWallet = await afterCrashEm.execute<
      Array<{
        balance: string;
        version: number;
      }>
    >(
      `
        select
          balance::text as balance,
          version
        from wallets
        where id = ?
      `,
      [wallet.id],
      'all',
    );

    expect(afterCrashWallet[0]?.balance).toBe('90.00');
    expect(afterCrashWallet[0]?.version).toBe(2);

    /*
     * O boundary da aplicação recebe exatamente a mesma
     * mensagem novamente após o "restart". Isso evita
     * depender do relógio de visibility timeout do emulador,
     * enquanto mantém o primeiro delivery e o ACK no SQS real.
     */
    const restartObservability =
      new ObservabilityService();

    const restartedConsumer =
      new WagerTransactionsSqsConsumer(
        new ProcessWagerUseCase(
          new MikroOrmWagerProcessingStore(
            orm.em.fork(),
          ),
        ),
        restartObservability,
      );

    const restartHarness =
      restartedConsumer as unknown as TestableConsumer;

    await restartHarness.processMessage(firstMessage!);

    expect(
      restartObservability.processMetrics()
        .duplicatesDetected,
    ).toBe(1);

    const verificationEm = orm.em.fork();

    const walletRows = await verificationEm.execute<
      Array<{
        balance: string;
        version: number;
      }>
    >(
      `
        select
          balance::text as balance,
          version
        from wallets
        where id = ?
      `,
      [wallet.id],
      'all',
    );

    expect(walletRows[0]?.balance).toBe('90.00');
    expect(walletRows[0]?.version).toBe(2);

    const transactionRows =
      await verificationEm.execute<
        Array<{ count: number }>
      >(
        `
          select count(*)::int as count
          from wager_transactions
          where provider_id = ?
            and external_transaction_id = ?
        `,
        [
          envelope.data.providerId,
          externalTransactionId,
        ],
        'all',
      );

    expect(transactionRows[0]?.count).toBe(1);

    const ledgerRows = await verificationEm.execute<
      Array<{ count: number }>
    >(
      `
        select count(*)::int as count
        from wallet_ledger_entries l
        join wager_transactions t
          on t.id = l.transaction_id
        where t.provider_id = ?
          and t.external_transaction_id = ?
          and l.direction = 'DEBIT'
      `,
      [
        envelope.data.providerId,
        externalTransactionId,
      ],
      'all',
    );

    expect(ledgerRows[0]?.count).toBe(1);

    const inboxRows = await verificationEm.execute<
      Array<{
        count: number;
        processed_count: number;
      }>
    >(
      `
        select
          count(*)::int as count,
          count(processed_at)::int as processed_count
        from inbox_messages
        where consumer_name = ?
          and message_id = ?
      `,
      [CONSUMER_NAME, messageId],
      'all',
    );

    expect(inboxRows[0]?.count).toBe(1);
    expect(inboxRows[0]?.processed_count).toBe(1);

    const outboxRows = await verificationEm.execute<
      Array<{ count: number }>
    >(
      `
        select count(*)::int as count
        from outbox_messages
        where payload -> 'data' ->> 'transactionId' = (
          select id::text
          from wager_transactions
          where provider_id = ?
            and external_transaction_id = ?
          limit 1
        )
      `,
      [
        envelope.data.providerId,
        externalTransactionId,
      ],
      'all',
    );

    expect(outboxRows[0]?.count).toBe(2);

    const queueAfterAck = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 0,
      }),
    );

    expect(queueAfterAck.Messages ?? []).toHaveLength(0);

    await crashingConsumer.onModuleDestroy();
    await restartedConsumer.onModuleDestroy();
  });

  test(
    'moves a permanently invalid message to the DLQ after five non-ACK deliveries',
    async () => {
      /*
       * Usa filas temporárias exclusivas deste teste.
       * Assim nenhum processo Nest externo pode disputar
       * a mensagem e tornar o teste dependente de timing.
       */
      const suffix = randomUUID().replaceAll('-', '');

      const createdDlq = await sqs.send(
        new CreateQueueCommand({
          QueueName:
            `wager-resilience-dlq-${suffix}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'true',
          },
        }),
      );

      const testDlqUrl = createdDlq.QueueUrl;

      expect(testDlqUrl).toBeDefined();

      const dlqAttributes = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: testDlqUrl!,
          AttributeNames: ['QueueArn'],
        }),
      );

      const dlqArn =
        dlqAttributes.Attributes?.QueueArn;

      expect(dlqArn).toBeDefined();

      const createdQueue = await sqs.send(
        new CreateQueueCommand({
          QueueName:
            `wager-resilience-${suffix}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'true',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: '5',
            }),
          },
        }),
      );

      const testQueueUrl = createdQueue.QueueUrl;

      expect(testQueueUrl).toBeDefined();

      try {
        const configuredAttributes =
          await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: testQueueUrl!,
              AttributeNames: ['RedrivePolicy'],
            }),
          );

        const redrivePolicy = JSON.parse(
          configuredAttributes.Attributes
            ?.RedrivePolicy ?? '{}',
        ) as {
          maxReceiveCount?: string;
          deadLetterTargetArn?: string;
        };

        expect(redrivePolicy.maxReceiveCount).toBe(
          '5',
        );
        expect(
          redrivePolicy.deadLetterTargetArn,
        ).toBe(dlqArn);

        const messageId = randomUUID();

        const invalidBody = JSON.stringify({
          messageId,
          type: 'UnsupportedPermanentMessage',
          occurredAt: new Date().toISOString(),
          data: {},
        });

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: testQueueUrl!,
            MessageBody: invalidBody,
            MessageGroupId:
              'invalid-message-group',
            MessageDeduplicationId: messageId,
          }),
        );

        const consumer =
          new WagerTransactionsSqsConsumer(
            {} as ProcessWagerUseCase,
            new ObservabilityService(),
          );

        const harness =
          consumer as unknown as TestableConsumer;

        let deliveries = 0;

        /*
         * O broker incrementa ApproximateReceiveCount
         * em cada ReceiveMessage. Como o consumidor
         * rejeita antes do DeleteMessage, a mensagem
         * nunca recebe ACK.
         *
         * Após cada falha zeramos explicitamente a
         * visibility timeout para tornar o teste rápido
         * e determinístico. O sexto ReceiveMessage
         * dispara o redrive da mensagem que já atingiu
         * maxReceiveCount=5.
         */
        for (
          let attempt = 0;
          attempt < 6;
          attempt += 1
        ) {
          const response = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: testQueueUrl!,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 0,
              VisibilityTimeout: 30,
              MessageSystemAttributeNames: ['ApproximateReceiveCount'],
            }),
          );

          const message = response.Messages?.[0];

          if (!message) {
            break;
          }

          deliveries += 1;

          expect(
            message.Attributes
              ?.ApproximateReceiveCount,
          ).toBe(String(deliveries));

          await expect(
            harness.processMessage(message),
          ).rejects.toThrow(
            'Unsupported message type',
          );

          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: testQueueUrl!,
              ReceiptHandle:
                message.ReceiptHandle!,
              VisibilityTimeout: 0,
            }),
          );

          await new Promise((resolve) =>
            setTimeout(resolve, 20),
          );
        }

        expect(deliveries).toBe(5);

        /*
         * Uma leitura adicional garante que o sweep
         * de redrive foi executado.
         */
        await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: testQueueUrl!,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 0,
            VisibilityTimeout: 0,
          }),
        );

        const dlqResponse = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: testDlqUrl!,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );

        const dlqMessage =
          dlqResponse.Messages?.[0];

        expect(dlqMessage).toBeDefined();
        expect(dlqMessage?.Body).toBe(
          invalidBody,
        );

        if (dlqMessage?.ReceiptHandle) {
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: testDlqUrl!,
              ReceiptHandle:
                dlqMessage.ReceiptHandle,
            }),
          );
        }

        await consumer.onModuleDestroy();
      } finally {
        await sqs.send(
          new DeleteQueueCommand({
            QueueUrl: testQueueUrl!,
          }),
        );

        await sqs.send(
          new DeleteQueueCommand({
            QueueUrl: testDlqUrl!,
          }),
        );
      }
    },
    15_000,
  );
});
