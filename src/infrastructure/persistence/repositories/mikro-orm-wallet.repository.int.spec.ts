import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { Wallet } from '../../../domain/entities/wallet';
import { Money } from '../../../domain/value-objects/money';
import mikroOrmConfig from '../../../mikro-orm.config';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository';
import { WalletPersistence } from '../entities/wallet.persistence';

describe('MikroOrmWalletRepository integration', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('persists and reloads a wallet from PostgreSQL', async () => {
    const em = orm.em.fork();
    const repository = new MikroOrmWalletRepository(em);

    const walletId = randomUUID();
    const playerId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({
        amount: '0.00',
        currency: 'BRL',
      }),
    });

    await repository.insert(wallet);

    em.clear();

    const reloaded = await repository.findById(walletId);
    const reloadedByPlayer =
      await repository.findByPlayerAndCurrency(playerId, 'BRL');

    expect(reloaded).not.toBeNull();
    expect(reloaded?.id).toBe(walletId);
    expect(reloaded?.playerId).toBe(playerId);
    expect(reloaded?.currency).toBe('BRL');
    expect(reloaded?.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(reloaded?.version).toBe(1);
    expect(reloadedByPlayer).not.toBeNull();
    expect(reloadedByPlayer?.id).toBe(walletId);

    await em.nativeDelete(WalletPersistence, {
      id: walletId,
    });
  });
});
