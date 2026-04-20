import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';

import { MiningAuthzService } from '../../services/mining-authz.service';

class IssueCodeBody {
  @IsString()
  @MinLength(4)
  deviceId: string;

  @IsString()
  @MinLength(8)
  payoutWalletHcash: string;
}

class ActivationChallengeStartBody {
  @IsString()
  @MinLength(4)
  activationCode: string;

  @IsString()
  @MinLength(42)
  ownerWalletEvm: string;
}

class ActivationChallengeVerifyBody {
  @IsString()
  @MinLength(6)
  challengeId: string;

  @IsString()
  @MinLength(42)
  ownerWalletEvm: string;

  @IsString()
  @MinLength(8)
  signature: string;
}

class TransferStartBody {
  @IsString()
  @MinLength(4)
  deviceId: string;

  @IsString()
  @MinLength(42)
  currentOwnerWalletEvm: string;

  @IsString()
  @MinLength(42)
  newOwnerWalletEvm: string;
}

class TransferVerifyBody {
  @IsString()
  @MinLength(6)
  challengeId: string;

  @IsString()
  @MinLength(8)
  currentOwnerSignature: string;

  @IsString()
  @MinLength(8)
  newOwnerSignature: string;
}

@Controller('activation')
export class ActivationController {
  constructor(private readonly miningAuthzService: MiningAuthzService) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  public activationPage(): string {
    return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HashCash Activation</title>
  <style>
    body { font-family: sans-serif; max-width: 760px; margin: 24px auto; padding: 0 12px; }
    input, button { font-size: 16px; padding: 10px; width: 100%; margin: 8px 0; }
    .ok { color: #0a7a28; }
    .err { color: #a11212; }
  </style>
</head>
<body>
  <h1>HashCash Miner Activation</h1>
  <p>Enter the activation code shown on your device, then sign with your EVM staking wallet.</p>
  <input id="activationCode" placeholder="Activation code" />
  <button id="activateButton">Activate</button>
  <p id="status"></p>
  <script>
    const statusEl = document.getElementById('status');
    const setStatus = (text, ok = false) => {
      statusEl.className = ok ? 'ok' : 'err';
      statusEl.textContent = text;
    };

    async function activate() {
      try {
        setStatus('');
        if (!window.ethereum) {
          throw new Error('No EVM wallet detected');
        }
        const code = (document.getElementById('activationCode').value || '').trim();
        if (!code) throw new Error('Activation code is required');

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const ownerWalletEvm = (accounts?.[0] || '').toLowerCase();
        if (!ownerWalletEvm) throw new Error('Wallet account unavailable');

        const startRes = await fetch('/api/activation/challenge/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ activationCode: code, ownerWalletEvm }),
        });
        const startData = await startRes.json();
        if (!startRes.ok) throw new Error(startData.detail || 'Challenge start failed');

        const signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [startData.messageToSign, ownerWalletEvm],
        });

        const verifyRes = await fetch('/api/activation/challenge/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            challengeId: startData.challengeId,
            ownerWalletEvm,
            signature,
          }),
        });
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok) throw new Error(verifyData.detail || 'Activation verification failed');

        setStatus('Activation complete. Return to your miner.', true);
      } catch (err) {
        setStatus(err?.message || String(err));
      }
    }

    document.getElementById('activateButton').addEventListener('click', activate);
  </script>
</body>
</html>
    `;
  }

  @Post('code')
  public async issueCode(@Body() body: IssueCodeBody) {
    return this.miningAuthzService.issueActivationCode(
      body.deviceId,
      body.payoutWalletHcash,
    );
  }

  @Get('status/:deviceId')
  public async status(@Param('deviceId') deviceId: string) {
    return this.miningAuthzService.getClaimStatus(deviceId);
  }

  @Post('challenge/start')
  public async startActivationChallenge(
    @Body() body: ActivationChallengeStartBody,
  ) {
    return this.miningAuthzService.startActivationChallenge(
      body.activationCode,
      body.ownerWalletEvm,
    );
  }

  @Post('challenge/verify')
  public async verifyActivationChallenge(
    @Body() body: ActivationChallengeVerifyBody,
  ) {
    return this.miningAuthzService.verifyActivationChallenge(
      body.challengeId,
      body.ownerWalletEvm,
      body.signature,
    );
  }

  @Post('transfer/challenge/start')
  public async startTransfer(@Body() body: TransferStartBody) {
    return this.miningAuthzService.startOwnershipTransferChallenge(
      body.deviceId,
      body.currentOwnerWalletEvm,
      body.newOwnerWalletEvm,
    );
  }

  @Post('transfer/challenge/verify')
  public async verifyTransfer(@Body() body: TransferVerifyBody) {
    return this.miningAuthzService.verifyOwnershipTransferChallenge(
      body.challengeId,
      body.currentOwnerSignature,
      body.newOwnerSignature,
    );
  }
}
