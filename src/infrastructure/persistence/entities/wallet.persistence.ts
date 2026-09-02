import { defineEntity, p } from '@mikro-orm/core';

export const WalletPersistence = defineEntity({
  name: 'WalletPersistence',
  tableName: 'wallets',

  properties: {
    id: p.uuid().primary(),

    playerId: p.string().length(128),

    currency: p.string().length(3),

    balance: p
      .decimal('string')
      .columnType('numeric(38,2)'),

    version: p.integer(),

    createdAt: p
      .datetime()
      .columnType('timestamptz'),

    updatedAt: p
      .datetime()
      .columnType('timestamptz'),
  },

  uniques: [
    {
      name: 'wallets_player_currency_unique',
      properties: ['playerId', 'currency'],
    },
  ],

  checks: [
    {
      name: 'wallets_balance_non_negative',
      expression: 'balance >= 0',
    },
    {
      name: 'wallets_version_positive',
      expression: 'version >= 1',
    },
    {
      name: 'wallets_currency_format',
      expression: "currency ~ '^[A-Z]{3}$'",
    },
  ],
});
