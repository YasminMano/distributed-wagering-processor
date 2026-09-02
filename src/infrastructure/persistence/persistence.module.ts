import { Module } from '@nestjs/common';

import {
  WAGER_PROCESSING_STORE,
} from '../../application/ports/wager-processing.store';
import {
  WALLET_CREATION_STORE,
} from '../../application/ports/wallet-creation.store';
import {
  WALLET_REPOSITORY,
} from '../../application/ports/wallet.repository';
import { MikroOrmWagerProcessingStore } from './repositories/mikro-orm-wager-processing.store';
import { MikroOrmWalletCreationStore } from './repositories/mikro-orm-wallet-creation.store';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

@Module({
  providers: [
    MikroOrmWalletRepository,
    MikroOrmWalletCreationStore,
    MikroOrmWagerProcessingStore,
    {
      provide: WALLET_REPOSITORY,
      useExisting: MikroOrmWalletRepository,
    },
    {
      provide: WALLET_CREATION_STORE,
      useExisting: MikroOrmWalletCreationStore,
    },
    {
      provide: WAGER_PROCESSING_STORE,
      useExisting: MikroOrmWagerProcessingStore,
    },
  ],
  exports: [
    WALLET_REPOSITORY,
    WALLET_CREATION_STORE,
    WAGER_PROCESSING_STORE,
  ],
})
export class PersistenceModule {}