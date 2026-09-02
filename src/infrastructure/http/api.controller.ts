import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Response } from 'express';

import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  ProcessWagerUseCase,
  WalletNotFoundError,
} from '../../application/use-cases/process-wager.use-case';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { ObservabilityService } from '../observability/observability.service';

interface CreateWalletBody {
  playerId?: string;
  initialBalance?: {
    amount?: string;
    currency?: string;
  };
}

interface ProcessWagerBody {
  providerId?: string;
  externalTransactionId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  kind?: string;
  money?: {
    amount?: string;
    currency?: string;
  };
  referenceExternalTransactionId?: string;
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  created_at: Date;
  processed_at: Date | null;
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

@Controller()
export class ApiController {
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey:
        process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  constructor(
    private readonly em: EntityManager,
    private readonly createWallet: CreateWalletUseCase,
    private readonly processWager: ProcessWagerUseCase,
    private readonly observability: ObservabilityService,
  ) {}

  @Post('wallets')
  async createWalletEndpoint(
    @Body() body: CreateWalletBody,
  ): Promise<Record<string, unknown>> {
    const playerId = this.requireString(
      body.playerId,
      'playerId',
    );

    const amount = this.requireString(
      body.initialBalance?.amount,
      'initialBalance.amount',
    );

    const currency = this.requireString(
      body.initialBalance?.currency,
      'initialBalance.currency',
    );

    try {
      const wallet = await this.createWallet.execute({
        playerId,
        initialBalance: {
          amount,
          currency,
        },
      });

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes('unique')
      ) {
        throw new ConflictException(
          'Wallet already exists for player and currency',
        );
      }

      throw this.asBadRequest(error);
    }
  }

  @Get('wallets/:walletId')
  async getWallet(
    @Param('walletId') walletId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.em.execute<WalletRow[]>(
      `
        select
          id,
          player_id,
          currency,
          balance::text,
          version,
          created_at,
          updated_at
        from wallets
        where id = ?
        limit 1
      `,
      [walletId],
      'all',
    );

    const wallet = rows[0];

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return {
      id: wallet.id,
      playerId: wallet.player_id,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at,
    };
  }

  @Get('wallets/:walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') requestedLimit?: string,
  ): Promise<Record<string, unknown>> {
    const parsed = Number.parseInt(
      requestedLimit ?? '50',
      10,
    );

    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, 100)
        : 50;

    const params: unknown[] = [walletId];

    let cursorClause = '';

    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, 'base64url').toString(
            'utf8',
          ),
        ) as {
          createdAt: string;
          id: string;
        };

        cursorClause = `
          and (
            created_at < ?
            or (
              created_at = ?
              and id::text < ?
            )
          )
        `;

        params.push(
          decoded.createdAt,
          decoded.createdAt,
          decoded.id,
        );
      } catch {
        throw new BadRequestException(
          'Invalid ledger cursor',
        );
      }
    }

    params.push(limit + 1);

    const rows = await this.em.execute<LedgerRow[]>(
      `
        select
          id,
          wallet_id,
          transaction_id,
          direction,
          amount::text,
          currency,
          balance_before::text,
          balance_after::text,
          created_at
        from wallet_ledger_entries
        where wallet_id = ?
        ${cursorClause}
        order by created_at desc, id::text desc
        limit ?
      `,
      params,
      'all',
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              createdAt:
                last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null;

    return {
      items: page.map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: {
          amount: row.amount,
          currency: row.currency,
        },
        balanceBefore: {
          amount: row.balance_before,
          currency: row.currency,
        },
        balanceAfter: {
          amount: row.balance_after,
          currency: row.currency,
        },
        createdAt: row.created_at,
      })),
      nextCursor,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(
    @Param('transactionId') transactionId: string,
  ): Promise<Record<string, unknown>> {
    const transaction =
      await this.findTransaction(
        'id = ?',
        [transactionId],
      );

    if (!transaction) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return this.mapTransactionRow(transaction);
  }

  @Get(
    'providers/:providerId/wagering/transactions/:externalTransactionId',
  )
  async getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId')
    externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    const transaction =
      await this.findTransaction(
        `
          provider_id = ?
          and external_transaction_id = ?
        `,
        [providerId, externalTransactionId],
      );

    if (!transaction) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return this.mapTransactionRow(transaction);
  }

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key')
    idempotencyKey: string | undefined,
    @Body() body: ProcessWagerBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required',
      );
    }

    const kind = this.parseKind(body.kind);
    const startedAt = Date.now();

    try {
      const result =
        await this.processWager.execute({
          idempotencyKey,
          providerId: this.requireString(
            body.providerId,
            'providerId',
          ),
          externalTransactionId:
            this.requireString(
              body.externalTransactionId,
              'externalTransactionId',
            ),
          playerId: this.requireString(
            body.playerId,
            'playerId',
          ),
          walletId: this.requireString(
            body.walletId,
            'walletId',
          ),
          roundId: this.requireString(
            body.roundId,
            'roundId',
          ),
          gameId: this.requireString(
            body.gameId,
            'gameId',
          ),
          kind,
          amount: this.requireString(
            body.money?.amount,
            'money.amount',
          ),
          currency: this.requireString(
            body.money?.currency,
            'money.currency',
          ),
          referenceExternalTransactionId:
            body.referenceExternalTransactionId,
        });

      const latencyMs = Date.now() - startedAt;

      if (result.replayed) {
        this.observability.recordDuplicate();
      }

      this.observability.recordProcessingLatency(
        latencyMs,
      );

      this.observability.log(
        'info',
        'http_wager_processed',
        {
          correlationId: idempotencyKey,
          transactionId: result.transaction.id,
          walletId: result.transaction.walletId,
          providerId: result.transaction.providerId,
        },
        {
          status: result.transaction.status,
          idempotentReplay: result.replayed,
          latencyMs,
        },
      );

      if (
        result.transaction.status ===
        WagerTransactionStatus.PendingReference
      ) {
        response.status(HttpStatus.ACCEPTED);
      } else if (
        result.transaction.status ===
        WagerTransactionStatus.Rejected
      ) {
        response.status(
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      } else {
        response.status(HttpStatus.OK);
      }

      return {
        transactionId: result.transaction.id,
        status: result.transaction.status,
        balance:
          result.transaction.observedBalance?.toJSON() ??
          null,
        idempotentReplay: result.replayed,
        ...(result.transaction.failureCode
          ? {
              failureCode:
                result.transaction.failureCode,
            }
          : {}),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;

      this.observability.recordLockConflictFrom(error);

      this.observability.log(
        'error',
        'http_wager_failed',
        {
          correlationId: idempotencyKey,
          walletId: body.walletId ?? null,
          providerId: body.providerId ?? null,
        },
        {
          error:
            error instanceof Error
              ? error.name
              : 'UnknownError',
          latencyMs,
        },
      );

      if (
        error instanceof IdempotencyConflictError ||
        error instanceof
          ExternalTransactionConflictError
      ) {
        throw new ConflictException(error.message);
      }

      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }

      if (error instanceof HttpException) {
        throw error;
      }

      throw this.asBadRequest(error);
    }
  }

  @Post('wallets/:walletId/reconciliation')
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.em.execute<
      Array<{
        wallet_id: string;
        currency: string;
        materialized_balance: string;
        ledger_balance: string;
        difference: string;
        consistent: boolean;
        ledger_entries: number;
      }>
    >(
      `
        select
          w.id as wallet_id,
          w.currency,
          w.balance::text
            as materialized_balance,
          coalesce(
            sum(
              case
                when l.direction = 'CREDIT'
                  then l.amount
                else -l.amount
              end
            ),
            0
          )::text as ledger_balance,
          (
            w.balance -
            coalesce(
              sum(
                case
                  when l.direction = 'CREDIT'
                    then l.amount
                  else -l.amount
                end
              ),
              0
            )
          )::numeric(38, 2)::text as difference,
          (
            w.balance =
            coalesce(
              sum(
                case
                  when l.direction = 'CREDIT'
                    then l.amount
                  else -l.amount
                end
              ),
              0
            )
          ) as consistent,
          count(l.id)::int as ledger_entries
        from wallets w
        left join wallet_ledger_entries l
          on l.wallet_id = w.id
        where w.id = ?
        group by
          w.id,
          w.currency,
          w.balance
      `,
      [walletId],
      'all',
    );

    const result = rows[0];

    if (!result) {
      throw new NotFoundException(
        'Wallet not found',
      );
    }

    if (!result.consistent) {
      this.observability.recordReconciliationDivergence();

      this.observability.log(
        'warn',
        'wallet_reconciliation_divergence',
        {
          walletId: result.wallet_id,
        },
        {
          checkedEntries: result.ledger_entries,
        },
      );
    }

    return {
      walletId: result.wallet_id,
      storedBalance: {
        amount: result.materialized_balance,
        currency: result.currency,
      },
      calculatedBalance: {
        amount: result.ledger_balance,
        currency: result.currency,
      },
      difference: {
        amount: result.difference,
        currency: result.currency,
      },
      consistent: result.consistent,
      checkedEntries: result.ledger_entries,
    };
  }

  @Get('metrics')
  async metrics(): Promise<Record<string, unknown>> {
    const statusRows = await this.em.execute<
      Array<{
        status: string;
        count: number;
      }>
    >(
      `
        select status, count(*)::int as count
        from wager_transactions
        group by status
        order by status
      `,
      [],
      'all',
    );

    const outboxRows = await this.em.execute<
      Array<{
        outbox_lag_ms: number;
      }>
    >(
      `
        select
          coalesce(
            extract(
              epoch from (
                now() - min(occurred_at)
              )
            ) * 1000,
            0
          )::float8 as outbox_lag_ms
        from outbox_messages
        where published_at is null
      `,
      [],
      'all',
    );

    let dlqMessages = 0;

    try {
      const attributes = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl:
            process.env.SQS_WAGER_DLQ_URL ??
            'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
          ],
        }),
      );

      dlqMessages =
        Number(
          attributes.Attributes
            ?.ApproximateNumberOfMessages ?? '0',
        ) +
        Number(
          attributes.Attributes
            ?.ApproximateNumberOfMessagesNotVisible ??
            '0',
        );
    } catch (error) {
      this.observability.log(
        'warn',
        'metrics_dlq_unavailable',
        {},
        {
          error:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        },
      );
    }

    return {
      transactionsByStatus: Object.fromEntries(
        statusRows.map((row) => [
          row.status,
          row.count,
        ]),
      ),
      ...this.observability.processMetrics(),
      dlqMessages,
      outboxLagMs:
        outboxRows[0]?.outbox_lag_ms ?? 0,
    };
  }

  @Get('health/live')
  live(): Record<string, string> {
    return {
      status: 'ok',
    };
  }

  @Get('health/ready')
  async ready(): Promise<Record<string, string>> {
    try {
      await this.em.execute('select 1');

      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl:
            process.env.SQS_WAGER_QUEUE_URL ??
            'http://localhost:4566/000000000000/wager-transactions.fifo',
          AttributeNames: ['QueueArn'],
        }),
      );

      return {
        status: 'ready',
      };
    } catch {
      throw new HttpException(
        {
          status: 'not_ready',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async findTransaction(
    whereClause: string,
    params: unknown[],
  ): Promise<TransactionRow | undefined> {
    const rows =
      await this.em.execute<TransactionRow[]>(
        `
          select
            id,
            provider_id,
            external_transaction_id,
            wallet_id,
            player_id,
            round_id,
            game_id,
            kind,
            amount::text,
            currency,
            reference_external_transaction_id,
            status,
            failure_code,
            created_at,
            processed_at
          from wager_transactions
          where ${whereClause}
          limit 1
        `,
        params,
        'all',
      );

    return rows[0];
  }

  private mapTransactionRow(
    transaction: TransactionRow,
  ): Record<string, unknown> {
    return {
      id: transaction.id,
      providerId: transaction.provider_id,
      externalTransactionId:
        transaction.external_transaction_id,
      walletId: transaction.wallet_id,
      playerId: transaction.player_id,
      roundId: transaction.round_id,
      gameId: transaction.game_id,
      kind: transaction.kind,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      referenceExternalTransactionId:
        transaction.reference_external_transaction_id,
      status: transaction.status,
      failureCode: transaction.failure_code,
      createdAt: transaction.created_at,
      processedAt: transaction.processed_at,
    };
  }

  private mapDomainTransaction(
    transaction: WagerTransaction,
  ): Record<string, unknown> {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId:
        transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId ??
        null,
      status: transaction.status,
      failureCode:
        transaction.failureCode ?? null,
      createdAt: transaction.createdAt.toISOString(),
      processedAt:
        transaction.processedAt?.toISOString() ??
        null,
    };
  }

  private parseKind(
    value: string | undefined,
  ): WagerTransactionKind {
    switch (value) {
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return value;

      default:
        throw new BadRequestException(
          'kind must be BET, WIN, LOSS, REFUND or ROLLBACK',
        );
    }
  }

  private requireString(
    value: string | undefined,
    field: string,
  ): string {
    if (
      typeof value !== 'string' ||
      value.trim().length === 0
    ) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    return value;
  }

  private asBadRequest(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    return new BadRequestException(
      error instanceof Error
        ? error.message
        : 'Invalid request',
    );
  }
}
