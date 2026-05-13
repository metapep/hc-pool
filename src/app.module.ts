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
import { DevicePolicyController } from './controllers/device-policy/device-policy.controller';
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
    // Postgres datastore (per device-class plan P-1, C13). Connection
    // settings come from POOL_PG_* env vars (see ops-private/ansible/
    // templates/pool.env.j2). Defaults to host.docker.internal mirroring
    // the existing pool->backend networking pattern.
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.POOL_PG_HOST || 'host.docker.internal',
      port: parseInt(process.env.POOL_PG_PORT || '5432', 10),
      username: process.env.POOL_PG_USER || 'hc_pool',
      password: process.env.POOL_PG_PASSWORD || '',
      database: process.env.POOL_PG_DATABASE || 'hashcash_pool',
      // synchronize is intentionally TRUE for v1 to match the previous
      // SQLite behavior; entities are auto-loaded and TypeORM creates the
      // schema on first start. Switch to migrations-only once the schema
      // stabilizes (deferred per plan).
      synchronize: true,
      autoLoadEntities: true,
      logging: false,
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
    // Per device-class plan P-2b: pool-side proxy for /api/policy and
    // /api/ota/report. Forwards to backend's /v1/device/policy and
    // /v1/device/ota/report respectively.
    DevicePolicyController,
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
