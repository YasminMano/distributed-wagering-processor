import { defineEntity, p } from '@mikro-orm/core';
import { WagerTransactionPersistence } from './wager-transaction.persistence';
import { WalletPersistence } from './wallet.persistence';

export const WalletLedgerEntryPersistence = defineEntity({
  name: 'WalletLedgerEntryPersistence',
  tableName: 'wallet_ledger_entries',

  properties: {
    id: p.uuid().primary(),

    wallet: () => p.manyToOne(WalletPersistence),

    transaction: () =>
      p.manyToOne(WagerTransactionPersistence),

    direction: p.string().length(6),

    amount: p
      .decimal('string')
      .columnType('numeric(38,2)'),

    currency: p.string().length(3),

    balanceBefore: p
      .decimal('string')
      .columnType('numeric(38,2)'),

    balanceAfter: p
      .decimal('string')
      .columnType('numeric(38,2)'),

    createdAt: p
      .datetime()
      .columnType('timestamptz'),
  },

  uniques: [
    {
      name: 'wallet_ledger_wallet_transaction_unique',
      properties: ['wallet', 'transaction'],
    },
  ],

  indexes: [
    {
      name: 'wallet_ledger_wallet_created_idx',
      properties: ['wallet', 'createdAt'],
    },
  ],

  checks: [
    {
      name: 'wallet_ledger_direction_valid',
      expression: "direction in ('DEBIT', 'CREDIT')",
    },
    {
      name: 'wallet_ledger_amount_positive',
      expression: 'amount > 0',
    },
    {
      name: 'wallet_ledger_currency_format',
      expression: "currency ~ '^[A-Z]{3}$'",
    },
    {
      name: 'wallet_ledger_balance_before_non_negative',
      expression: 'balance_before >= 0',
    },
    {
      name: 'wallet_ledger_balance_after_non_negative',
      expression: 'balance_after >= 0',
    },
    {
      name: 'wallet_ledger_arithmetic_consistent',
      expression:
        "((direction = 'DEBIT' and balance_before - amount = balance_after) or (direction = 'CREDIT' and balance_before + amount = balance_after))",
    },
  ],
});
