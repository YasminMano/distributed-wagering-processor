import type { InferEntity } from '@mikro-orm/core';

import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/entities/wallet-ledger-entry';
import { Money } from '../../../domain/value-objects/money';
import { WalletLedgerEntryPersistence } from '../entities/wallet-ledger-entry.persistence';

type WalletLedgerEntryPersistenceEntity =
  InferEntity<typeof WalletLedgerEntryPersistence>;

export class WalletLedgerEntryMapper {
  static toDomain(
    entity: WalletLedgerEntryPersistenceEntity,
  ): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.wallet.id,
      transactionId: entity.transaction.id,
      direction: entity.direction as LedgerDirection,
      money: Money.from({
        amount: entity.amount,
        currency: entity.currency,
      }),
      balanceBefore: Money.from({
        amount: entity.balanceBefore,
        currency: entity.currency,
      }),
      balanceAfter: Money.from({
        amount: entity.balanceAfter,
        currency: entity.currency,
      }),
      createdAt: entity.createdAt,
    });
  }

  static toPersistence(entry: WalletLedgerEntry) {
    const money = entry.money.toJSON();

    return {
      id: entry.id,
      wallet: entry.walletId,
      transaction: entry.transactionId,
      direction: entry.direction,
      amount: money.amount,
      currency: money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    };
  }
}
