import { createHash } from 'node:crypto';

import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { ProcessWagerUseCase } from '../../application/use-cases/process-wager.use-case';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';

const CONSUMER_NAME = 'wager-transactions-consumer';

interface WagerRequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: {
      amount: string;
      currency: string;
    };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class WagerTransactionsSqsConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly queueUrl =
    process.env.SQS_WAGER_QUEUE_URL ??
    'http://localhost:4566/000000000000/wager-transactions.fifo';

  private readonly client = new SQSClient({
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

  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly processor: ProcessWagerUseCase,
  ) {}

  onModuleInit(): void {
    this.loop = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    await this.loop;
    this.client.destroy();
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'sqs_consumer_error',
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }),
        );

        await new Promise((resolve) =>
          setTimeout(resolve, 1000),
        );
      }
    }
  }

  async pollOnce(): Promise<void> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 30,
      }),
    );

    for (const message of response.Messages ?? []) {
      await this.processMessage(message);
    }
  }

  private async processMessage(
    message: Message,
  ): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) {
      return;
    }

    const envelope = JSON.parse(
      message.Body,
    ) as WagerRequestedMessage;

    if (envelope.type !== 'WagerTransactionRequested') {
      throw new Error(
        `Unsupported message type: ${envelope.type}`,
      );
    }

    const payloadHash = createHash('sha256')
      .update(message.Body)
      .digest('hex');

    await this.processor.executeFromInbox(
      {
        idempotencyKey: envelope.data.idempotencyKey,
        providerId: envelope.data.providerId,
        externalTransactionId:
          envelope.data.externalTransactionId,
        walletId: envelope.data.walletId,
        playerId: envelope.data.playerId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        amount: envelope.data.money.amount,
        currency: envelope.data.money.currency,
        referenceExternalTransactionId:
          envelope.data.referenceExternalTransactionId,
      },
      {
        consumerName: CONSUMER_NAME,
        messageId: envelope.messageId,
        payloadHash,
        receivedAt: new Date(),
      },
    );

    /*
     * Só remove da fila depois que executeFromInbox()
     * terminou. Nesse ponto a transação SQL já commitou.
     */
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
}
