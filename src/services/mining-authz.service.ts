import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Agent as HttpsAgent } from 'https';
import { firstValueFrom } from 'rxjs';
import * as fs from 'node:fs';

export interface PoolChallenge {
  challengeId: string;
  nonce: string;
  expiresAt: number;
  issuedAt: number;
}

export interface ChallengeVerifyRequest {
  deviceId: string;
  payoutWalletHcash: string;
  challengeId: string;
  nonce: string;
  expiresAt: number;
  proof: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
  mode?: string;
}

export interface ActivationCodeIssueResponse {
  ok: boolean;
  deviceId: string;
  status: string;
  activationCode?: string | null;
  expiresAt?: number | null;
  activationUrl?: string;
  ownerWalletEvm?: string | null;
}

export interface ActivationChallengeStartResponse {
  ok: boolean;
  challengeId: string;
  deviceId: string;
  ownerWalletEvm: string;
  expiresAt: number;
  messageToSign: string;
}

export interface ActivationChallengeVerifyResponse {
  ok: boolean;
  deviceId: string;
  ownerWalletEvm: string;
  status: string;
}

export interface OwnershipTransferStartResponse {
  ok: boolean;
  challengeId: string;
  deviceId: string;
  currentOwnerWalletEvm: string;
  newOwnerWalletEvm: string;
  expiresAt: number;
  messageToSign: string;
}

@Injectable()
export class MiningAuthzService {
  private readonly enabled: boolean;
  private readonly backendUrl: string;
  private readonly backendApiKey: string;
  private readonly challengeTtlMs: number;
  private readonly httpsAgent?: HttpsAgent;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.enabled =
      `${
        this.configService.get('MINING_AUTHZ_ENABLED') ?? 'true'
      }`.toLowerCase() === 'true';
    this.backendUrl = `${
      this.configService.get('MINING_BACKEND_URL') ?? ''
    }`.replace(/\/+$/, '');
    this.backendApiKey = `${
      this.configService.get('MINING_BACKEND_API_KEY') ?? ''
    }`;
    this.challengeTtlMs = Number.parseInt(
      `${this.configService.get('MINING_CHALLENGE_TTL_MS') ?? '30000'}`,
      10,
    );
    this.httpsAgent = this.buildHttpsAgent();
    if (this.enabled && this.backendUrl.length === 0) {
      throw new Error(
        'MINING_BACKEND_URL is required when MINING_AUTHZ_ENABLED=true',
      );
    }
    if (this.enabled && this.backendApiKey.length === 0) {
      throw new Error(
        'MINING_BACKEND_API_KEY is required when MINING_AUTHZ_ENABLED=true',
      );
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public createChallenge(): PoolChallenge {
    const now = Date.now();
    return {
      challengeId: randomBytes(12).toString('hex'),
      nonce: randomBytes(16).toString('hex'),
      issuedAt: now,
      expiresAt: now + this.challengeTtlMs,
    };
  }

  public async verifyChallenge(
    payload: ChallengeVerifyRequest,
  ): Promise<AuthorizationResult> {
    if (!this.enabled) {
      return { allowed: true, mode: 'disabled' };
    }
    const response = await this.post('/v1/device/challenge/verify', payload);
    return this.normalizeResult(response);
  }

  public async authorizeMining(
    deviceId: string,
    payoutWalletHcash: string,
  ): Promise<AuthorizationResult> {
    if (!this.enabled) {
      return { allowed: true, mode: 'disabled' };
    }
    const response = await this.post('/v1/mining/authorize', {
      deviceId,
      payoutWalletHcash,
    });
    return this.normalizeResult(response);
  }

  public async issueActivationCode(
    deviceId: string,
    payoutWalletHcash: string,
  ): Promise<ActivationCodeIssueResponse> {
    const response = await this.post('/v1/activation/code', {
      deviceId,
      payoutWalletHcash,
    });
    return response as ActivationCodeIssueResponse;
  }

  public async getClaimStatus(deviceId: string): Promise<unknown> {
    return this.get(
      `/v1/device/claim/status?deviceId=${encodeURIComponent(deviceId)}`,
    );
  }

  public async startActivationChallenge(
    activationCode: string,
    ownerWalletEvm: string,
  ): Promise<ActivationChallengeStartResponse> {
    const response = await this.post('/v1/activation/challenge/start', {
      activationCode,
      ownerWalletEvm,
    });
    return response as ActivationChallengeStartResponse;
  }

  public async verifyActivationChallenge(
    challengeId: string,
    ownerWalletEvm: string,
    signature: string,
  ): Promise<ActivationChallengeVerifyResponse> {
    const response = await this.post('/v1/activation/challenge/verify', {
      challengeId,
      ownerWalletEvm,
      signature,
    });
    return response as ActivationChallengeVerifyResponse;
  }

  public async startOwnershipTransferChallenge(
    deviceId: string,
    currentOwnerWalletEvm: string,
    newOwnerWalletEvm: string,
  ): Promise<OwnershipTransferStartResponse> {
    const response = await this.post('/v1/ownership/transfer/challenge/start', {
      deviceId,
      currentOwnerWalletEvm,
      newOwnerWalletEvm,
    });
    return response as OwnershipTransferStartResponse;
  }

  public async verifyOwnershipTransferChallenge(
    challengeId: string,
    currentOwnerSignature: string,
    newOwnerSignature: string,
  ): Promise<unknown> {
    return this.post('/v1/ownership/transfer/challenge/verify', {
      challengeId,
      currentOwnerSignature,
      newOwnerSignature,
    });
  }

  private async post(path: string, data: object): Promise<unknown> {
    const response = await firstValueFrom(
      this.httpService.post(`${this.backendUrl}${path}`, data, {
        headers: this.enabled
          ? {
              'x-api-key': this.backendApiKey,
            }
          : undefined,
        httpsAgent: this.httpsAgent,
        timeout: Number.parseInt(
          `${this.configService.get('MINING_BACKEND_TIMEOUT_MS') ?? '5000'}`,
          10,
        ),
      }),
    );
    return response.data;
  }

  private async get(path: string): Promise<unknown> {
    const response = await firstValueFrom(
      this.httpService.get(`${this.backendUrl}${path}`, {
        headers: this.enabled
          ? {
              'x-api-key': this.backendApiKey,
            }
          : undefined,
        httpsAgent: this.httpsAgent,
        timeout: Number.parseInt(
          `${this.configService.get('MINING_BACKEND_TIMEOUT_MS') ?? '5000'}`,
          10,
        ),
      }),
    );
    return response.data;
  }

  private normalizeResult(response: unknown): AuthorizationResult {
    const payload = (response ?? {}) as Record<string, unknown>;
    const allowed = payload.allowed === true;
    const reason =
      typeof payload.reason === 'string' ? payload.reason : undefined;
    const mode = typeof payload.mode === 'string' ? payload.mode : undefined;
    return { allowed, reason, mode };
  }

  private buildHttpsAgent(): HttpsAgent | undefined {
    const caPath = `${
      this.configService.get('MINING_BACKEND_TLS_CA_PATH') ?? ''
    }`.trim();
    const certPath = `${
      this.configService.get('MINING_BACKEND_TLS_CERT_PATH') ?? ''
    }`.trim();
    const keyPath = `${
      this.configService.get('MINING_BACKEND_TLS_KEY_PATH') ?? ''
    }`.trim();
    const rejectUnauthorized =
      `${
        this.configService.get('MINING_BACKEND_TLS_REJECT_UNAUTHORIZED') ??
        'true'
      }`.toLowerCase() === 'true';

    if (caPath.length === 0 && certPath.length === 0 && keyPath.length === 0) {
      return undefined;
    }

    return new HttpsAgent({
      ca: caPath.length > 0 ? fs.readFileSync(caPath) : undefined,
      cert: certPath.length > 0 ? fs.readFileSync(certPath) : undefined,
      key: keyPath.length > 0 ? fs.readFileSync(keyPath) : undefined,
      rejectUnauthorized,
    });
  }
}
