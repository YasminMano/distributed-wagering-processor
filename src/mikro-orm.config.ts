import 'dotenv/config';

import { InboxMessagePersistence } from './infrastructure/persistence/entities/inbox-message.persistence';

import { WalletLedgerEntryPersistence } from './infrastructure/persistence/entities/wallet-ledger-entry.persistence';
import { WagerTransactionPersistence } from './infrastructure/persistence/entities/wager-transaction.persistence';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletPersistence } from './infrastructure/persistence/entities/wallet.persistence';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

export default defineConfig({
  clientUrl: databaseUrl,

  entities: [
    InboxMessagePersistence,
    WalletPersistence,
    WagerTransactionPersistence,
    WalletLedgerEntryPersistence,
  ],

  extensions: [
    Migrator,
  ],

  schemaGenerator: {
    ignoreTriggers: true,
    ignoreRoutines: true,
  },

  migrations: {
    path: './dist/infrastructure/persistence/migrations',
    pathTs: './src/infrastructure/persistence/migrations',
    transactional: true,
    allOrNothing: true,
  },
});
