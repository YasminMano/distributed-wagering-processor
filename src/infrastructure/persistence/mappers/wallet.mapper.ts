import type { InferEntity } from '@mikro-orm/core';

import { Wallet } from '../../../domain/entities/wallet';
import { Money } from '../../../domain/value-objects/money';
import { WalletPersistence } from '../entities/wallet.persistence';

type WalletPersistenceEntity = InferEntity<typeof WalletPersistence>;

export class WalletMapper {
  static toDomain(entity: WalletPersistenceEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  static toPersistence(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}