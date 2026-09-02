import { PersistenceModule } from './infrastructure/persistence/persistence.module';

import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import {
  WAGER_PROCESSING_STORE,
  WagerProcessingStore,
} from './application/ports/wager-processing.store';
import {
  WALLET_CREATION_STORE,
  WalletCreationStore,
} from './application/ports/wallet-creation.store';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerUseCase } from './application/use-cases/process-wager.use-case';
import { AppController } from './app.controller';
import { ApiController } from './infrastructure/http/api.controller';
import { AppService } from './app.service';
import mikroOrmConfig from './mikro-orm.config';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker';
import { WagerTransactionsSqsConsumer } from './infrastructure/messaging/wager-transactions-sqs.consumer';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    PersistenceModule,
  ],
  controllers: [AppController, ApiController],
  providers: [
    AppService,
    WagerTransactionsSqsConsumer,
    OutboxPublisherWorker,
    {
      provide: CreateWalletUseCase,
      inject: [WALLET_CREATION_STORE],
      useFactory: (store: WalletCreationStore) =>
        new CreateWalletUseCase(store),
    },
    {
      provide: ProcessWagerUseCase,
      inject: [WAGER_PROCESSING_STORE],
      useFactory: (store: WagerProcessingStore) =>
        new ProcessWagerUseCase(store),
    },
  ],
})
export class AppModule {}
