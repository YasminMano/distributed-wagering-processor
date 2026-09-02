import { PersistenceModule } from './infrastructure/persistence/persistence.module';

import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import {
  WAGER_PROCESSING_STORE,
  WagerProcessingStore,
} from './application/ports/wager-processing.store';
import { ProcessWagerUseCase } from './application/use-cases/process-wager.use-case';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import mikroOrmConfig from './mikro-orm.config';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker';
import { WagerTransactionsSqsConsumer } from './infrastructure/messaging/wager-transactions-sqs.consumer';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    PersistenceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    WagerTransactionsSqsConsumer,
    OutboxPublisherWorker,
    {
      provide: ProcessWagerUseCase,
      inject: [WAGER_PROCESSING_STORE],
      useFactory: (store: WagerProcessingStore) =>
        new ProcessWagerUseCase(store),
    },
  ],
})
export class AppModule {}
