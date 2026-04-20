import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { ActivationController } from './controllers/activation/activation.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { ExternalShareController } from './controllers/external-share/external-share.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { ExternalSharesModule } from './ORM/external-shares/external-shares.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { DiscordService } from './services/discord.service';
import { ExternalSharesService } from './services/external-shares.service';
import { MiningAuthzService } from './services/mining-authz.service';
import { MiningSessionMetricsService } from './services/mining-session-metrics.service';
import { NotificationService } from './services/notification.service';
import { SignetBlockSigningService } from './services/signet-block-signing.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { TelegramService } from './services/telegram.service';

const ORMModules = [
  ClientStatisticsModule,
  ClientModule,
  AddressSettingsModule,
  TelegramSubscriptionsModule,
  BlocksModule,
  RpcBlocksModule,
  ExternalSharesModule,
];

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: './DB/public-pool.sqlite',
      synchronize: true,
      autoLoadEntities: true,
      logging: false,
      enableWAL: true,
      busyTimeout: 30 * 1000,
    }),
    CacheModule.register(),
    ScheduleModule.forRoot(),
    HttpModule,
    ...ORMModules,
  ],
  controllers: [
    AppController,
    ClientController,
    AddressController,
    ExternalShareController,
    ActivationController,
  ],
  providers: [
    DiscordService,
    AppService,
    StratumV1Service,
    TelegramService,
    BitcoinRpcService,
    NotificationService,
    BitcoinAddressValidator,
    StratumV1JobsService,
    BTCPayService,
    BraiinsService,
    ExternalSharesService,
    MiningAuthzService,
    MiningSessionMetricsService,
    SignetBlockSigningService,
  ],
})
export class AppModule {}
