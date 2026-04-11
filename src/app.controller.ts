import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { getActiveChainProfile } from './network/chain-profile';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';

@Controller()
export class AppController {

  private uptime = new Date();
  private static readonly HALVING_BLOCKS = 210000;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
  ) { }

  @Get('info')
  public async info() {


    const CACHE_KEY = 'SITE_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();
    const highScores = await this.addressSettingsService.getHighScores();

    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.uptime
    };

    //1 min
    await this.cacheManager.set(CACHE_KEY, data, 1 * 60 * 1000);

    return data;

  }

  @Get('pool')
  public async pool() {

    const CACHE_KEY = 'POOL_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const userAgents = await this.clientService.getUserAgents();
    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + parseInt(userAgent.count), 0);
    const blockHeight = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
    const blocksFound = await this.blocksService.getFoundBlocks();
    const devFeeAddress = `${process.env.DEV_FEE_ADDRESS ?? ''}`.trim();
    const parsedDevFeePercent = Number.parseFloat(`${process.env.DEV_FEE_PERCENT ?? ''}`);
    const configuredFeePercent = Number.isFinite(parsedDevFeePercent) && parsedDevFeePercent > 0 && parsedDevFeePercent < 100
      ? parsedDevFeePercent
      : 1.5;
    const effectiveFeePercent = devFeeAddress.length > 0 ? configuredFeePercent : 0;

    const data = {
      totalHashRate,
      blockHeight,
      totalMiners,
      blocksFound,
      fee: effectiveFeePercent
    }

    //5 min
    await this.cacheManager.set(CACHE_KEY, data, 5 * 60 * 1000);

    return data;
  }

  @Get('network')
  public async network() {
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    return miningInfo;
  }

  @Get('network/stats')
  public async networkStats() {
    return this.getNetworkStats();
  }

  @Get('stats')
  public async stats() {
    return this.getNetworkStats();
  }

  @Get('diagnostics')
  public async diagnostics() {
    const CACHE_KEY = 'POOL_DIAGNOSTICS';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chainProfile = getActiveChainProfile();
    const nowMs = Date.now();

    const [
      miningInfo,
      userAgents,
      activeClients,
      oneMinuteShares,
      fiveMinuteShares,
      fifteenMinuteShares,
    ] = await Promise.all([
      firstValueFrom(this.bitcoinRpcService.newBlock$),
      this.clientService.getUserAgents(),
      this.clientService.getActiveClients(),
      this.clientStatisticsService.getShareSnapshot(1),
      this.clientStatisticsService.getShareSnapshot(5),
      this.clientStatisticsService.getShareSnapshot(15),
    ]);

    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + Number.parseFloat(userAgent.totalHashRate ?? '0'), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + Number.parseInt(userAgent.count ?? '0', 10), 0);

    const sessions = activeClients.map((client) => {
      const heartbeatAt = client.updatedAt != null ? new Date(client.updatedAt) : null;
      const heartbeatValid = heartbeatAt != null && Number.isFinite(heartbeatAt.getTime());
      const lastHeartbeatAt = heartbeatValid ? heartbeatAt.toISOString() : null;
      const secondsSinceLastHeartbeat = heartbeatValid
        ? Math.max(0, Math.floor((nowMs - heartbeatAt.getTime()) / 1000))
        : null;

      return {
        address: client.address,
        worker: client.clientName,
        sessionId: client.sessionId,
        userAgent: client.userAgent,
        hashRate: Number(client.hashRate ?? 0),
        bestDifficulty: Number(client.bestDifficulty ?? 0),
        startTime: client.startTime != null ? new Date(client.startTime).toISOString() : null,
        lastHeartbeatAt,
        secondsSinceLastHeartbeat,
      };
    });

    const data = {
      timestamp: new Date(nowMs).toISOString(),
      uptime: this.uptime,
      chain: miningInfo?.chain ?? null,
      blockHeight: Number(miningInfo?.blocks ?? 0),
      networkHashrate: Number(miningInfo?.networkhashps ?? 0),
      networkDifficulty: Number(miningInfo?.difficulty ?? 0),
      connectedMiners: totalMiners,
      activeSessions: sessions.length,
      poolHashrate: totalHashRate,
      shareWindows: {
        oneMinute: oneMinuteShares,
        fiveMinute: fiveMinuteShares,
        fifteenMinute: fifteenMinuteShares,
      },
      difficultyConfig: {
        init: chainProfile.stratumInitDiff,
        min: chainProfile.stratumMinDiff,
        max: chainProfile.stratumMaxDiff,
        targetSharesPerSecond: chainProfile.stratumTargetSharesPerSecond,
      },
      rejectedSharesTracked: false,
      staleSharesTracked: false,
      sessions,
    };

    await this.cacheManager.set(CACHE_KEY, data, 10 * 1000);
    return data;
  }

  private async getNetworkStats() {
    const CACHE_KEY = 'NETWORK_STATS';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    const blockHeight = Number(miningInfo?.blocks ?? 0);
    const blocksTillHalving = blockHeight > 0
      ? (((Math.floor(blockHeight / AppController.HALVING_BLOCKS) + 1) * AppController.HALVING_BLOCKS) - blockHeight)
      : 0;

    const mediumFeeSatVb = await this.bitcoinRpcService.getMediumFeeSatVb();

    const data = {
      blockHeight,
      blocksTillHalving,
      mediumFeeSatVb,
      networkDifficulty: Number(miningInfo?.difficulty ?? 0),
      networkHashrate: Number(miningInfo?.networkhashps ?? 0),
      priceUsd: 0,
    };

    await this.cacheManager.set(CACHE_KEY, data, 30 * 1000);

    return data;
  }

  @Get('info/chart')
  public async infoChart() {


    const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    //10 min
    await this.cacheManager.set(CACHE_KEY, chartData, 10 * 60 * 1000);

    return chartData;


  }

}
