import { defineEntity, p } from '@mikro-orm/core';
import { WalletPersistence } from './wallet.persistence';

export const WagerTransactionPersistence = defineEntity({
  name: 'WagerTransactionPersistence',
  tableName: 'wager_transactions',

  properties: {
    id: p.uuid().primary(),

    providerId: p.string().length(128),

    externalTransactionId: p.string().length(128),

    idempotencyKey: p.string().length(255),

    payloadHash: p.string().length(64),

    wallet: () => p.manyToOne(WalletPersistence),

    playerId: p.string().length(128),

    roundId: p.string().length(128),

    gameId: p.string().length(128),

    kind: p.string().length(16),

    amount: p
      .decimal('string')
      .columnType('numeric(38,2)'),

    currency: p.string().length(3),

    referenceExternalTransactionId: p
      .string()
      .length(128)
      .nullable(),

    referenceTransaction: () => p
    .manyToOne(WagerTransactionPersistence)
    .mapToPk()
    .nullable(),

    status: p.string().length(32),

    failureCode: p
      .string()
      .length(64)
      .nullable(),

    createdAt: p
      .datetime()
      .columnType('timestamptz'),

    processedAt: p
      .datetime()
      .columnType('timestamptz')
      .nullable(),

    observedBalance: p
      .decimal('string')
      .columnType('numeric(38,2)')
      .nullable(),

    retryAttempts: p.integer().default(0),

    nextRetryAt: p
      .datetime()
      .columnType('timestamptz')
      .nullable(),
  },

  uniques: [
    {
      name: 'wager_transactions_provider_external_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      name: 'wager_transactions_idempotency_key_unique',
      properties: ['idempotencyKey'],
    },
  ],

  indexes: [
    {
      name: 'wager_transactions_wallet_status_idx',
      properties: ['wallet', 'status'],
    },
    {
      name: 'wager_transactions_reference_external_idx',
      properties: ['providerId', 'referenceExternalTransactionId'],
    },
    {
      name: 'wager_transactions_status_created_idx',
      properties: ['status', 'createdAt'],
    },
    {
      name: 'wager_transactions_pending_reference_retry_idx',
      properties: ['status', 'nextRetryAt'],
    },
  ],

  checks: [
    {
      name: 'wager_transactions_amount_positive',
      expression: 'amount > 0',
    },
    {
      name: 'wager_transactions_currency_format',
      expression: "currency ~ '^[A-Z]{3}$'",
    },
    {
      name: 'wager_transactions_kind_valid',
      expression:
        "kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
    },
    {
      name: 'wager_transactions_status_valid',
      expression:
        "status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
    },
    {
      name: 'wager_transactions_reference_required',
      expression:
        "(kind not in ('REFUND', 'ROLLBACK')) or reference_external_transaction_id is not null",
    },
    {
      name: 'wager_transactions_failure_code_required',
      expression:
        "(status not in ('REJECTED', 'FAILED')) or failure_code is not null",
    },
    {
      name: 'wager_transactions_processed_at_required',
      expression:
        "status <> 'PROCESSED' or processed_at is not null",
    },
    {
      name: 'wager_transactions_resolved_reference_required',
      expression:
        "status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null",
    },
    {
      name: 'wager_transactions_retry_attempts_valid',
      expression: 'retry_attempts between 0 and 5',
    },
  ],
});
