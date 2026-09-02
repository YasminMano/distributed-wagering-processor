import { Module } from '@nestjs/common';

import { WALLET_REPOSITORY } from '../../application/ports/wallet.repository';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

@Module({
  providers: [
    MikroOrmWalletRepository,
    {
      provide: WALLET_REPOSITORY,
      useExisting: MikroOrmWalletRepository,
    },
  ],
  exports: [
    WALLET_REPOSITORY,
  ],
})
export class PersistenceModule {}
