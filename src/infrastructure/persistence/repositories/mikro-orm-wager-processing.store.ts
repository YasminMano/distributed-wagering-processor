import { randomUUID } from 'node:crypto';

import { LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  InboxClaimResult,
  InboxMessageInput,
  OutboxMessageInput,
  WagerProcessingStore,
  WagerProcessingUnitOfWork,
} from '../../../application/ports/wager-processing.store';
import { Wallet } from '../../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import { InboxMessagePersistence } from '../entities/inbox-message.persistence';
import { OutboxMessagePersistence } from '../entities/outbox-message.persistence';
import { WagerTransactionPersistence } from '../entities/wager-transaction.persistence';
import { WalletLedgerEntryPersistence } from '../entities/wallet-ledger-entry.persistence';
import { WalletPersistence } from '../entities/wallet.persistence';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';
import { WalletMapper } from '../mappers/wallet.mapper';

class MikroOrmWagerProcessingUnitOfWork
  implements WagerProcessingUnitOfWork
{
  constructor(private readonly em: EntityManager) {}

  async claimInboxMessage(
    message: InboxMessageInput,
  ): Promise<InboxClaimResult> {
    const inserted = await this.em.execute<
      Array<{ payload_hash: string }>
    >(
      `
        insert into "inbox_messages" (
          "id",
          "consumer_name",
          "message_id",
          "payload_hash",
          "received_at"
        )
        values (?, ?, ?, ?, ?)
        on conflict ("consumer_name", "message_id")
        do nothing
        returning "payload_hash"
      `,
      [
        randomUUID(),
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
      ],
      'all',
    );

    if (inserted.length > 0) {
      return 'CLAIMED';
    }

    const existing = await this.em.findOne(
      InboxMessagePersistence,
      {
        consumerName: message.consumerName,
        messageId: message.messageId,
      },
    );

    if (!existing) {
      throw new Error(
        'Inbox message conflict could not be resolved',
      );
    }

    return existing.payloadHash === message.payloadHash
      ? 'DUPLICATE'
      : 'CONFLICT';
  }

  async markInboxMessageProcessed(
    consumerName: string,
    messageId: string,
    processedAt: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessagePersistence,
      {
        consumerName,
        messageId,
      },
      {
        processedAt,
      },
    );
  }

  async findWalletForUpdate(
    id: string,
  ): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletPersistence,
      { id },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      },
    );

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionPersistence,
      {
        idempotencyKey,
      },
    );

    return entity
      ? WagerTransactionMapper.toDomain(entity)
      : null;
  }

  async findTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionPersistence,
      {
        providerId,
        externalTransactionId,
      },
    );

    return entity
      ? WagerTransactionMapper.toDomain(entity)
      : null;
  }

  async findProcessedReversalByReferenceTransactionId(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionPersistence,
      {
        referenceTransaction: referenceTransactionId,
        kind,
        status: WagerTransactionStatus.Processed,
      },
    );

    return entity
      ? WagerTransactionMapper.toDomain(entity)
      : null;
  }

  async findDuePendingReferenceTransactionIds(
    now: Date,
  ): Promise<string[]> {
    const entities = await this.em.find(
      WagerTransactionPersistence,
      {
        status: WagerTransactionStatus.PendingReference,
        nextRetryAt: { $lte: now },
      },
      {
        limit: 100,
        orderBy: { nextRetryAt: 'asc' },
      },
    );

    return entities.map((entity) => entity.id);
  }

  async lockTransactionForPendingReferenceRetry(
    transactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionPersistence,
      { id: transactionId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return entity
      ? WagerTransactionMapper.toDomain(entity)
      : null;
  }

  async updateWallet(wallet: Wallet): Promise<void> {
    const money = wallet.balance.toJSON();

    await this.em.nativeUpdate(
      WalletPersistence,
      {
        id: wallet.id,
      },
      {
        balance: money.amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
  }

  async insertTransaction(
    transaction: WagerTransaction,
  ): Promise<void> {
    await this.em.insert(
      WagerTransactionPersistence,
      WagerTransactionMapper.toPersistence(transaction),
    );
  }

  async updateTransaction(
    transaction: WagerTransaction,
  ): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionPersistence,
      { id: transaction.id },
      {
        referenceTransaction:
          transaction.referenceTransactionId ?? null,
        status: transaction.status,
        failureCode: transaction.failureCode ?? null,
        processedAt: transaction.processedAt ?? null,
        retryAttempts: transaction.retryAttempts,
        nextRetryAt: transaction.nextRetryAt ?? null,
      },
    );
  }

  async insertLedgerEntry(
    entry: WalletLedgerEntry,
  ): Promise<void> {
    await this.em.insert(
      WalletLedgerEntryPersistence,
      WalletLedgerEntryMapper.toPersistence(entry),
    );
  }

  async insertOutboxMessage(
    message: OutboxMessageInput,
  ): Promise<void> {
    await this.em.insert(OutboxMessagePersistence, {
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
}

@Injectable()
export class MikroOrmWagerProcessingStore
  implements WagerProcessingStore
{
  constructor(private readonly em: EntityManager) {}

  async execute<T>(
    work: (
      unitOfWork: WagerProcessingUnitOfWork,
    ) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (em) => {
      const unitOfWork =
        new MikroOrmWagerProcessingUnitOfWork(em);

      return work(unitOfWork);
    });
  }
}
