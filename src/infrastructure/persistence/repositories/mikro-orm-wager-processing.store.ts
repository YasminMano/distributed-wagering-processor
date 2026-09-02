import { LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import {
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

  async insertLedgerEntry(
    entry: WalletLedgerEntry,
  ): Promise<void> {
    await this.em.insert(
      WalletLedgerEntryPersistence,
      WalletLedgerEntryMapper.toPersistence(entry),
    );
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
