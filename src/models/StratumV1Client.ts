import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import {
  IJobTemplate,
  StratumV1JobsService,
} from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { warnIfNonHcashNetwork } from '../network/hcash-network';
import { ChainProfile, getActiveChainProfile } from '../network/chain-profile';
import {
  ChallengeVerifyRequest,
  MiningAuthzService,
  PoolChallenge,
} from '../services/mining-authz.service';
import { SignetBlockSigningService } from '../services/signet-block-signing.service';

interface DeviceChallengeMessage {
  id: string | number | null;
  method: string;
  params: [string, string];
}

interface DeviceAuthMessage {
  id: string | number | null;
  method: string;
  params: [string, string, string, string];
}

export class StratumV1Client {
  private clientSubscription: SubscriptionMessage;
  private clientConfiguration: ConfigurationMessage;
  private clientAuthorization: AuthorizationMessage;
  private clientSuggestedDifficulty: SuggestDifficulty;
  private stratumSubscription: Subscription;
  private backgroundWork: NodeJS.Timer[] = [];

  private statistics: StratumV1ClientStatistics;
  private stratumInitialized = false;
  private usedSuggestedDifficulty = false;
  private readonly chainProfile: ChainProfile;
  private sessionDifficulty: number;
  private readonly requiresDeviceAuth: boolean;
  private deviceAuthorized = false;
  private pendingChallenge?: PoolChallenge & {
    deviceId: string;
    wallet: string;
  };
  private deviceSession?: { deviceId: string; wallet: string };

  private entity: ClientEntity;
  private creatingEntity: Promise<void>;

  public extraNonceAndSessionId: string;
  public sessionStart: Date;
  public noFee: boolean;
  public hashRate = 0;

  private buffer = '';

  private miningSubmissionHashes = new Set<string>();

  constructor(
    public readonly socket: Socket,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly externalSharesService: ExternalSharesService,
    private readonly miningAuthzService: MiningAuthzService,
    private readonly signetBlockSigningService: SignetBlockSigningService,
  ) {
    this.chainProfile = getActiveChainProfile();
    this.sessionDifficulty = this.chainProfile.stratumInitDiff;
    this.requiresDeviceAuth = this.miningAuthzService.isEnabled();
    this.deviceAuthorized = !this.requiresDeviceAuth;

    this.socket.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

      lines
        .filter((m) => m.length > 0)
        .forEach(async (m) => {
          try {
            await this.handleMessage(m);
          } catch (e) {
            await this.socket.end();
            console.error(e);
          }
        });
    });
  }

  private clampDifficulty(value: number): number {
    const safeValue = Number.isFinite(value)
      ? value
      : this.chainProfile.stratumInitDiff;
    return Math.max(
      this.chainProfile.stratumMinDiff,
      Math.min(safeValue, this.chainProfile.stratumMaxDiff),
    );
  }

  private parseDeviceChallengeMessage(
    payload: any,
  ): DeviceChallengeMessage | null {
    if (
      payload == null ||
      !Array.isArray(payload.params) ||
      payload.params.length !== 2
    ) {
      return null;
    }
    const [deviceId, wallet] = payload.params;
    if (typeof deviceId !== 'string' || deviceId.length < 4) {
      return null;
    }
    if (typeof wallet !== 'string' || wallet.length < 8) {
      return null;
    }
    return {
      id: payload.id ?? null,
      method: payload.method,
      params: [deviceId, wallet],
    };
  }

  private parseDeviceAuthMessage(payload: any): DeviceAuthMessage | null {
    if (
      payload == null ||
      !Array.isArray(payload.params) ||
      payload.params.length !== 4
    ) {
      return null;
    }
    const [deviceId, wallet, challengeId, proof] = payload.params;
    if (typeof deviceId !== 'string' || deviceId.length < 4) {
      return null;
    }
    if (typeof wallet !== 'string' || wallet.length < 8) {
      return null;
    }
    if (typeof challengeId !== 'string' || challengeId.length < 4) {
      return null;
    }
    if (typeof proof !== 'string' || proof.length < 8) {
      return null;
    }
    return {
      id: payload.id ?? null,
      method: payload.method,
      params: [deviceId, wallet, challengeId, proof],
    };
  }

  private async isSessionAuthorized(): Promise<boolean> {
    if (!this.requiresDeviceAuth) {
      return true;
    }
    if (this.deviceSession == null) {
      return false;
    }
    const result = await this.miningAuthzService.authorizeMining(
      this.deviceSession.deviceId,
      this.deviceSession.wallet,
    );
    if (!result.allowed) {
      console.warn(
        `Authorization revoked for session ${this.extraNonceAndSessionId}: ${
          result.reason ?? 'unspecified'
        }`,
      );
      this.deviceAuthorized = false;
      this.deviceSession = null;
      return false;
    }
    return true;
  }

  private async enforceSessionAuthorizationOrClose(): Promise<boolean> {
    const allowed = await this.isSessionAuthorized();
    if (!allowed) {
      await this.socket.end();
      return false;
    }
    return true;
  }

  public async destroy() {
    if (this.extraNonceAndSessionId) {
      await this.clientService.delete(this.extraNonceAndSessionId);
    }

    if (this.stratumSubscription != null) {
      this.stratumSubscription.unsubscribe();
    }

    this.backgroundWork.forEach((work) => {
      clearInterval(work);
    });
  }

  private getRandomHexString() {
    const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
    const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
    const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
    return hexString;
  }

  private async handleMessage(message: string) {
    //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

    // Parse the message and check if it's the initial subscription message
    let parsedMessage = null;
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      //console.log("Invalid JSON");
      await this.socket.end();
      return;
    }

    switch (parsedMessage.method) {
      case eRequestMethod.SUBSCRIBE: {
        const subscriptionMessage = plainToInstance(
          SubscriptionMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(subscriptionMessage, validatorOptions);

        if (errors.length === 0) {
          if (this.sessionStart == null) {
            this.sessionStart = new Date();
            this.statistics = new StratumV1ClientStatistics(
              this.clientStatisticsService,
              {
                minDiff: this.chainProfile.stratumMinDiff,
                targetSubmissionPerSecond:
                  this.chainProfile.stratumTargetSharesPerSecond,
              },
            );
            this.extraNonceAndSessionId = this.getRandomHexString();
            console.log(
              `New client ID: : ${this.extraNonceAndSessionId}, ${this.socket.remoteAddress}:${this.socket.remotePort}`,
            );
          }

          this.clientSubscription = subscriptionMessage;
          const success = await this.write(
            JSON.stringify(
              this.clientSubscription.response(this.extraNonceAndSessionId),
            ) + '\n',
          );
          if (!success) {
            return;
          }
        } else {
          console.error('Subscription validation error');
          const err = new StratumErrorMessage(
            subscriptionMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Subscription validation error',
            errors,
          ).response();
          console.error(err);
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }

        break;
      }
      case eRequestMethod.CONFIGURE: {
        const configurationMessage = plainToInstance(
          ConfigurationMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(configurationMessage, validatorOptions);

        if (errors.length === 0) {
          this.clientConfiguration = configurationMessage;
          //const response = this.buildSubscriptionResponse(configurationMessage.id);
          const success = await this.write(
            JSON.stringify(this.clientConfiguration.response()) + '\n',
          );
          if (!success) {
            return;
          }
        } else {
          console.error('Configuration validation error');
          const err = new StratumErrorMessage(
            configurationMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Configuration validation error',
            errors,
          ).response();
          console.error(err);
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }

        break;
      }
      case eRequestMethod.AUTHORIZE: {
        const authorizationMessage = plainToInstance(
          AuthorizationMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(authorizationMessage, validatorOptions);

        if (errors.length === 0) {
          this.clientAuthorization = authorizationMessage;
          const success = await this.write(
            JSON.stringify(this.clientAuthorization.response()) + '\n',
          );
          if (!success) {
            return;
          }
        } else {
          console.error('Authorization validation error');
          const err = new StratumErrorMessage(
            authorizationMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Authorization validation error',
            errors,
          ).response();
          console.error(err);
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }

        break;
      }
      case eRequestMethod.DEVICE_CHALLENGE: {
        const challengeMessage =
          this.parseDeviceChallengeMessage(parsedMessage);
        if (challengeMessage == null) {
          const err = new StratumErrorMessage(
            parsedMessage?.id ?? null,
            eStratumErrorCode.OtherUnknown,
            'Device challenge validation error',
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        const [deviceId, wallet] = challengeMessage.params;
        if (
          this.clientAuthorization != null &&
          this.clientAuthorization.address !== wallet
        ) {
          const err = new StratumErrorMessage(
            challengeMessage.id,
            eStratumErrorCode.UnauthorizedWorker,
            'Wallet must match mining.authorize address',
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        this.pendingChallenge = {
          ...this.miningAuthzService.createChallenge(),
          deviceId,
          wallet,
        };
        const response = {
          id: challengeMessage.id,
          error: null,
          result: {
            challenge_id: this.pendingChallenge.challengeId,
            nonce: this.pendingChallenge.nonce,
            expires_at: this.pendingChallenge.expiresAt,
          },
        };
        const success = await this.write(JSON.stringify(response) + '\n');
        if (!success) {
          return;
        }
        break;
      }
      case eRequestMethod.DEVICE_AUTH: {
        const authMessage = this.parseDeviceAuthMessage(parsedMessage);
        if (authMessage == null) {
          const err = new StratumErrorMessage(
            parsedMessage?.id ?? null,
            eStratumErrorCode.OtherUnknown,
            'Device auth validation error',
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        const [deviceId, wallet, challengeId, proof] = authMessage.params;
        if (
          this.pendingChallenge == null ||
          this.pendingChallenge.challengeId !== challengeId ||
          this.pendingChallenge.deviceId !== deviceId ||
          this.pendingChallenge.wallet !== wallet ||
          this.pendingChallenge.expiresAt < Date.now()
        ) {
          const err = new StratumErrorMessage(
            authMessage.id,
            eStratumErrorCode.UnauthorizedWorker,
            'Challenge is invalid or expired',
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        if (
          this.clientAuthorization != null &&
          this.clientAuthorization.address !== wallet
        ) {
          const err = new StratumErrorMessage(
            authMessage.id,
            eStratumErrorCode.UnauthorizedWorker,
            'Wallet must match mining.authorize address',
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        const verifyPayload: ChallengeVerifyRequest = {
          deviceId,
          wallet,
          challengeId,
          nonce: this.pendingChallenge.nonce,
          expiresAt: this.pendingChallenge.expiresAt,
          proof,
        };

        const verifyResult = await this.miningAuthzService.verifyChallenge(
          verifyPayload,
        );
        if (!verifyResult.allowed) {
          const err = new StratumErrorMessage(
            authMessage.id,
            eStratumErrorCode.UnauthorizedWorker,
            `Challenge verification failed: ${
              verifyResult.reason ?? 'unauthorized'
            }`,
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        const authorizationResult =
          await this.miningAuthzService.authorizeMining(deviceId, wallet);
        if (!authorizationResult.allowed) {
          const err = new StratumErrorMessage(
            authMessage.id,
            eStratumErrorCode.UnauthorizedWorker,
            `Mining authorization denied: ${
              authorizationResult.reason ?? 'unauthorized'
            }`,
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
          break;
        }

        this.deviceAuthorized = true;
        this.deviceSession = { deviceId, wallet };
        this.pendingChallenge = undefined;
        const response = {
          id: authMessage.id,
          error: null,
          result: true,
        };
        const success = await this.write(JSON.stringify(response) + '\n');
        if (!success) {
          return;
        }
        break;
      }
      case eRequestMethod.SUGGEST_DIFFICULTY: {
        if (this.usedSuggestedDifficulty == true) {
          return;
        }

        const suggestDifficultyMessage = plainToInstance(
          SuggestDifficulty,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(
          suggestDifficultyMessage,
          validatorOptions,
        );

        if (errors.length === 0) {
          this.clientSuggestedDifficulty = suggestDifficultyMessage;
          this.sessionDifficulty = this.clampDifficulty(
            suggestDifficultyMessage.suggestedDifficulty,
          );
          const success = await this.write(
            JSON.stringify(
              this.clientSuggestedDifficulty.response(this.sessionDifficulty),
            ) + '\n',
          );
          if (!success) {
            return;
          }
          this.usedSuggestedDifficulty = true;
        } else {
          console.error('Suggest difficulty validation error');
          const err = new StratumErrorMessage(
            suggestDifficultyMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Suggest difficulty validation error',
            errors,
          ).response();
          console.error(err);
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }
        break;
      }
      case eRequestMethod.SUBMIT: {
        if (this.stratumInitialized == false) {
          console.log('Submit before initalized');
          await this.socket.end();
          return;
        }

        const miningSubmitMessage = plainToInstance(
          MiningSubmitMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(miningSubmitMessage, validatorOptions);

        if (errors.length === 0 && this.stratumInitialized == true) {
          const result = await this.handleMiningSubmission(miningSubmitMessage);
          if (result == true) {
            const success = await this.write(
              JSON.stringify(miningSubmitMessage.response()) + '\n',
            );
            if (!success) {
              return;
            }
          }
        } else {
          console.log('Mining Submit validation error');
          const err = new StratumErrorMessage(
            miningSubmitMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Mining Submit validation error',
            errors,
          ).response();
          console.error(err);
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }
        break;
      }
      // default: {
      //     console.log("Invalid message");
      //     console.log(parsedMessage);
      //     await this.socket.end();
      //     return;
      // }
    }

    if (
      this.clientSubscription != null &&
      this.clientAuthorization != null &&
      this.stratumInitialized == false &&
      (!this.requiresDeviceAuth || this.deviceAuthorized)
    ) {
      await this.initStratum();
    }
  }

  private async initStratum() {
    this.stratumInitialized = true;

    switch (this.clientSubscription.userAgent) {
      case 'cpuminer': {
        this.sessionDifficulty = this.clampDifficulty(0.1);
      }
    }

    if (this.clientSuggestedDifficulty == null) {
      //console.log(`Setting difficulty to ${this.sessionDifficulty}`)
      const setDifficulty = JSON.stringify(
        new SuggestDifficulty().response(this.sessionDifficulty),
      );
      const success = await this.write(setDifficulty + '\n');
      if (!success) {
        return;
      }
    }

    this.stratumSubscription =
      this.stratumV1JobsService.newMiningJob$.subscribe(async (jobTemplate) => {
        try {
          if (jobTemplate.blockData.clearJobs) {
            this.miningSubmissionHashes.clear();
          }
          await this.sendNewMiningJob(jobTemplate);
        } catch (e) {
          await this.socket.end();
          console.error(e);
        }
      });

    this.backgroundWork.push(
      setInterval(async () => {
        await this.checkDifficulty();
      }, 60 * 1000),
    );

    if (this.requiresDeviceAuth) {
      this.backgroundWork.push(
        setInterval(async () => {
          await this.enforceSessionAuthorizationOrClose();
        }, 15 * 1000),
      );
    }
  }

  private async sendNewMiningJob(jobTemplate: IJobTemplate) {
    if (!(await this.enforceSessionAuthorizationOrClose())) {
      return;
    }

    let payoutInformation;
    const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
    const devFeePercentRaw = this.configService.get('DEV_FEE_PERCENT');
    const parsedDevFeePercent = Number.parseFloat(`${devFeePercentRaw ?? ''}`);
    const devFeePercent =
      Number.isFinite(parsedDevFeePercent) &&
      parsedDevFeePercent > 0 &&
      parsedDevFeePercent < 100
        ? parsedDevFeePercent
        : 1.5;
    const minerPercent = 100 - devFeePercent;
    if (this.entity) {
      this.hashRate = this.statistics.hashRate;
    }
    this.noFee = devFeeAddress == null || devFeeAddress.length < 1;
    if (this.noFee) {
      payoutInformation = [
        { address: this.clientAuthorization.address, percent: 100 },
      ];
    } else {
      payoutInformation = [
        { address: devFeeAddress, percent: devFeePercent },
        { address: this.clientAuthorization.address, percent: minerPercent },
      ];
    }

    const networkConfig = this.configService.get('NETWORK');
    warnIfNonHcashNetwork(networkConfig);

    const job = new MiningJob(
      this.configService,
      this.stratumV1JobsService.getNextId(),
      payoutInformation,
      jobTemplate,
    );

    this.stratumV1JobsService.addJob(job);

    const success = await this.write(job.response(jobTemplate));
    if (!success) {
      return;
    }

    //console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.extraNonceAndSessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!this.noFee})`)
  }

  private async handleMiningSubmission(submission: MiningSubmitMessage) {
    if (!(await this.enforceSessionAuthorizationOrClose())) {
      return false;
    }

    if (this.entity == null) {
      if (this.creatingEntity == null) {
        this.creatingEntity = new Promise(async (resolve, reject) => {
          try {
            this.entity = await this.clientService.insert({
              sessionId: this.extraNonceAndSessionId,
              address: this.clientAuthorization.address,
              clientName: this.clientAuthorization.worker,
              userAgent: this.clientSubscription.userAgent,
              startTime: new Date(),
              bestDifficulty: 0,
            });
          } catch (e) {
            reject(e);
          }
          resolve();
        });
        await this.creatingEntity;
      } else {
        await this.creatingEntity;
      }
    }

    const submissionHash = submission.hash();
    if (this.miningSubmissionHashes.has(submissionHash)) {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.DuplicateShare,
        'Duplicate share',
      ).response();
      const success = await this.write(err);
      if (!success) {
        return false;
      }
      return false;
    } else {
      this.miningSubmissionHashes.add(submissionHash);
    }

    const job = this.stratumV1JobsService.getJobById(submission.jobId);

    // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification (or expired, 5 min)
    if (job == null) {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.JobNotFound,
        'Job not found',
      ).response();
      //console.log(err);
      const success = await this.write(err);
      if (!success) {
        return false;
      }
      return false;
    }
    const jobTemplate = this.stratumV1JobsService.getJobTemplateById(
      job.jobTemplateId,
    );
    if (jobTemplate == null) {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.JobNotFound,
        'Job template not found',
      ).response();
      const success = await this.write(err);
      if (!success) {
        return false;
      }
      return false;
    }

    const templateIsStale = this.stratumV1JobsService.isTemplateStale(
      job.jobTemplateId,
    );
    if (
      templateIsStale &&
      !this.stratumV1JobsService.isTemplateWithinGraceWindow(job.jobTemplateId)
    ) {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.JobNotFound,
        'Job stale',
      ).response();
      const success = await this.write(err);
      if (!success) {
        return false;
      }
      return false;
    }

    const updatedJobBlock = job.copyAndUpdateBlock(
      jobTemplate,
      parseInt(submission.versionMask, 16),
      parseInt(submission.nonce, 16),
      this.extraNonceAndSessionId,
      submission.extraNonce2,
      parseInt(submission.ntime, 16),
    );
    const header = updatedJobBlock.toBuffer(true);
    const { submissionDifficulty } =
      DifficultyUtils.calculateDifficulty(header);
    const unsignedNetworkDifficulty =
      DifficultyUtils.calculateDifficultyFromBits(updatedJobBlock.bits);

    //console.log(`DIFF: ${submissionDifficulty} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonceAndSessionId}`);

    if (submissionDifficulty >= this.sessionDifficulty) {
      if (
        !templateIsStale &&
        submissionDifficulty >= unsignedNetworkDifficulty
      ) {
        const signetReadyBlock = this.signetBlockSigningService.signBlock(
          updatedJobBlock,
          jobTemplate.blockData.signetChallenge,
        );
        const signedHeader = signetReadyBlock.toBuffer(true);
        const { submissionDifficulty: signedSubmissionDifficulty } =
          DifficultyUtils.calculateDifficulty(signedHeader);
        const signedNetworkDifficulty =
          DifficultyUtils.calculateDifficultyFromBits(signetReadyBlock.bits);

        if (signedSubmissionDifficulty >= signedNetworkDifficulty) {
          const blockHex = signetReadyBlock.toHex(false);
          const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
          const submitAccepted = result == null || result === 'SUCCESS!';
          if (submitAccepted) {
            console.log('!!! BLOCK FOUND !!!');
            await this.blocksService.save({
              height: jobTemplate.blockData.height,
              minerAddress: this.clientAuthorization.address,
              worker: this.clientAuthorization.worker,
              sessionId: this.extraNonceAndSessionId,
              blockData: blockHex,
            });

            await this.notificationService.notifySubscribersBlockFound(
              this.clientAuthorization.address,
              jobTemplate.blockData.height,
              signetReadyBlock,
              result,
            );
            await this.addressSettingsService.resetBestDifficultyAndShares();
          }
        } else {
          console.warn(
            `Discarded candidate after signet signing (session ${this.extraNonceAndSessionId}): signedDifficulty=${signedSubmissionDifficulty}, networkDifficulty=${signedNetworkDifficulty}`,
          );
        }
      }
      try {
        await this.statistics.addShares(this.entity, this.sessionDifficulty);
        const now = new Date();
        // only update every minute
        if (
          this.entity.updatedAt == null ||
          now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60
        ) {
          await this.clientService.heartbeat(
            this.entity.address,
            this.entity.clientName,
            this.entity.sessionId,
            this.hashRate,
            now,
          );
          this.entity.updatedAt = now;
        }
      } catch (e) {
        console.log(e);
      }

      if (submissionDifficulty > this.entity.bestDifficulty) {
        await this.clientService.updateBestDifficulty(
          this.extraNonceAndSessionId,
          submissionDifficulty,
        );
        this.entity.bestDifficulty = submissionDifficulty;
        if (
          submissionDifficulty >
          (
            await this.addressSettingsService.getSettings(
              this.clientAuthorization.address,
              true,
            )
          ).bestDifficulty
        ) {
          await this.addressSettingsService.updateBestDifficulty(
            this.clientAuthorization.address,
            submissionDifficulty,
            this.entity.userAgent,
          );
        }
      }

      const externalShareSubmissionEnabled: boolean =
        this.configService
          .get('EXTERNAL_SHARE_SUBMISSION_ENABLED')
          ?.toLowerCase() == 'true';
      const minimumDifficulty: number =
        parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) ||
        1000000000000.0; // 1T
      if (
        externalShareSubmissionEnabled &&
        submissionDifficulty >= minimumDifficulty
      ) {
        // Submit share to API if enabled
        this.externalSharesService.submitShare({
          worker: this.clientAuthorization.worker,
          address: this.clientAuthorization.address,
          userAgent: this.clientSubscription.userAgent,
          header: header.toString('hex'),
          externalPoolName:
            this.configService.get('POOL_IDENTIFIER') || 'Public-Pool',
        });
      }
    } else {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.LowDifficultyShare,
        'Difficulty too low',
      ).response();

      const success = await this.write(err);
      if (!success) {
        return false;
      }

      return false;
    }

    //await this.checkDifficulty();
    return true;
  }

  private async checkDifficulty() {
    const targetDiff = this.statistics.getSuggestedDifficulty(
      this.sessionDifficulty,
    );
    if (targetDiff == null) {
      return;
    }

    if (targetDiff != this.sessionDifficulty) {
      //console.log(`Adjusting ${this.extraNonceAndSessionId} difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
      this.sessionDifficulty = this.clampDifficulty(targetDiff);

      const data =
        JSON.stringify({
          id: null,
          method: eResponseMethod.SET_DIFFICULTY,
          params: [this.sessionDifficulty],
        }) + '\n';

      await this.socket.write(data);

      const jobTemplate = await firstValueFrom(
        this.stratumV1JobsService.newMiningJob$,
      );
      // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
      jobTemplate.blockData.clearJobs = true;
      await this.sendNewMiningJob(jobTemplate);
    }
  }

  private async write(message: string): Promise<boolean> {
    try {
      if (!this.socket.destroyed && !this.socket.writableEnded) {
        await new Promise((resolve, reject) => {
          this.socket.write(message, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve(true);
            }
          });
        });

        return true;
      } else {
        console.error(
          `Error: Cannot write to closed or ended socket. ${this.extraNonceAndSessionId} ${message}`,
        );
        this.destroy();
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
        return false;
      }
    } catch (error) {
      this.destroy();
      if (!this.socket.writableEnded) {
        await this.socket.end();
      } else if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      console.error(
        `Error occurred while writing to socket: ${this.extraNonceAndSessionId}`,
        error,
      );
      return false;
    }
  }
}
