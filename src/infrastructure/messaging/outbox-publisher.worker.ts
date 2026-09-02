import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

interface PendingOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisherWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly queueUrl =
    process.env.SQS_EVENT_QUEUE_URL ??
    'http://localhost:4566/000000000000/wager-events.fifo';

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

  constructor(private readonly em: EntityManager) {}

  onModuleInit(): void {
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.client.destroy();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const processed = await this.publishBatch();

        if (processed === 0) {
          await this.sleep(250);
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'outbox_publisher_error',
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }),
        );

        await this.sleep(1000);
      }
    }
  }

  async publishBatch(): Promise<number> {
    return this.em.transactional(async (em) => {
      /*
       * SKIP LOCKED permite vários publishers:
       * cada instância pega linhas diferentes.
       */
      const rows = await em.execute<PendingOutboxRow[]>(
        `
          select
            id,
            aggregate_id,
            event_type,
            payload,
            attempts
          from outbox_messages
          where published_at is null
            and (
              next_attempt_at is null
              or next_attempt_at <= now()
            )
          order by occurred_at
          for update skip locked
          limit 20
        `,
        [],
        'all',
      );

      for (const row of rows) {
        try {
          await this.client.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(row.payload),
              MessageGroupId: row.aggregate_id,
              MessageDeduplicationId: row.id,
            }),
          );

          await em.execute(
            `
              update outbox_messages
              set
                attempts = attempts + 1,
                published_at = now(),
                next_attempt_at = null
              where id = ?
            `,
            [row.id],
          );
        } catch {
          const attempts = row.attempts + 1;

          const delaySeconds = Math.min(
            60,
            2 ** Math.min(attempts, 6),
          );

          await em.execute(
            `
              update outbox_messages
              set
                attempts = attempts + 1,
                next_attempt_at =
                  now() + (? * interval '1 second')
              where id = ?
            `,
            [delaySeconds, row.id],
          );
        }
      }

      return rows.length;
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, ms),
    );
  }
}
