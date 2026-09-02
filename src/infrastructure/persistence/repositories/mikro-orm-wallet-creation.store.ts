import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { WalletCreationStore } from '../../../application/ports/wallet-creation.store';
import type { OutboxMessageInput } from '../../../application/ports/wager-processing.store';
import { Wallet } from '../../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../../domain/entities/wager-transaction';
import { WagerTransactionPersistence } from '../entities/wager-transaction.persistence';
import { OutboxMessagePersistence } from '../entities/outbox-message.persistence';
import { WalletLedgerEntryPersistence } from '../entities/wallet-ledger-entry.persistence';
import { WalletPersistence } from '../entities/wallet.persistence';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';
import { WalletMapper } from '../mappers/wallet.mapper';

@Injectable()
export class MikroOrmWalletCreationStore
  implements WalletCreationStore
{
  constructor(private readonly em: EntityManager) {}

  async create(
    wallet: Wallet,
    openingTransaction?: WagerTransaction,
    openingLedgerEntry?: WalletLedgerEntry,
    outboxMessages: OutboxMessageInput[] = [],
  ): Promise<void> {
    if (
      Boolean(openingTransaction) !==
      Boolean(openingLedgerEntry)
    ) {
      throw new Error(
        'Opening transaction and ledger entry must be persisted together',
      );
    }

    await this.em.transactional(async (em) => {
      await em.insert(
        WalletPersistence,
        WalletMapper.toPersistence(wallet),
      );

      if (openingTransaction && openingLedgerEntry) {
        await em.insert(
          WagerTransactionPersistence,
          WagerTransactionMapper.toPersistence(
            openingTransaction,
          ),
        );

        await em.insert(
          WalletLedgerEntryPersistence,
          WalletLedgerEntryMapper.toPersistence(
            openingLedgerEntry,
          ),
        );
      }

      for (const message of outboxMessages) {
        await em.insert(OutboxMessagePersistence, {
          id: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          payload: message.payload,
          occurredAt: message.occurredAt,
          attempts: 0,
          nextAttemptAt: null,
          publishedAt: null,
        });
      }
    });
  }
}
