import { Module } from '@nestjs/common';

import {
  WALLET_CREATION_STORE,
} from '../../application/ports/wallet-creation.store';
import {
  WALLET_REPOSITORY,
} from '../../application/ports/wallet.repository';
import { MikroOrmWalletCreationStore } from './repositories/mikro-orm-wallet-creation.store';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

@Module({
  providers: [
    MikroOrmWalletRepository,
    MikroOrmWalletCreationStore,
    {
      provide: WALLET_REPOSITORY,
      useExisting: MikroOrmWalletRepository,
    },
    {
      provide: WALLET_CREATION_STORE,
      useExisting: MikroOrmWalletCreationStore,
    },
  ],
  exports: [
    WALLET_REPOSITORY,
    WALLET_CREATION_STORE,
  ],
})
export class PersistenceModule {}