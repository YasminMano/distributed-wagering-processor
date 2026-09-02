import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { WalletRepository } from '../../../application/ports/wallet.repository';
import { Wallet } from '../../../domain/entities/wallet';
import { WalletPersistence } from '../entities/wallet.persistence';
import { WalletMapper } from '../mappers/wallet.mapper';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletPersistence, {
      id,
    });

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletPersistence, {
      playerId,
      currency,
    });

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(
      WalletPersistence,
      WalletMapper.toPersistence(wallet),
    );
  }
}