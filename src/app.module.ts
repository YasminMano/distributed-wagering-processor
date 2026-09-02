import { PersistenceModule } from './infrastructure/persistence/persistence.module';

import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import mikroOrmConfig from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    PersistenceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
