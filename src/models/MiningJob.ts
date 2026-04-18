import * as bitcoinjs from 'bitcoinjs-lib';
import { toHcashOutputScript } from '../network/hcash-network';
import { getActiveChainProfile } from '../network/chain-profile';

import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';
import { ConfigService } from '@nestjs/config';

const MAX_BLOCK_WEIGHT = 4000000;
const MAX_SCRIPT_SIZE = 100; //   https://github.com/bitcoin/bitcoin/blob/ffdc3d6060f6e65e69cf115a13b83e6eb4a0a0a8/src/consensus/tx_check.cpp#L49
interface AddressObject {
  address: string;
  percent: number;
}
export class MiningJob {
  private coinbaseTransaction: bitcoinjs.Transaction;
  private coinbasePart1: string;
  private coinbasePart2: string;
  private readonly chainProfile = getActiveChainProfile();

  public jobTemplateId: string;
  public networkDifficulty: number;
  public creation: number;
  public ownerSessionId: string;
  public signetLocked = false;
  public lockedExtraNonce2?: string;
  public lockedNtime?: number;
  public lockedVersionMask = 0;

  constructor(
    configService: ConfigService,
    public jobId: string,
    ownerSessionId: string,
    payoutInformation: AddressObject[],
    jobTemplate: IJobTemplate,
  ) {
    this.creation = new Date().getTime();
    this.ownerSessionId = ownerSessionId;
    this.jobTemplateId = jobTemplate.blockData.id;

    this.coinbaseTransaction = this.createCoinbaseTransaction(
      payoutInformation,
      jobTemplate.blockData.coinbasevalue,
    );

    //    39th byte onwards: Optional data with no consensus meaning
    // Initial pool identifier
    const poolIdentifier =
      configService.get('POOL_IDENTIFIER') || 'Public-Pool';
    const extra = Buffer.from(poolIdentifier);

    // Encode the block height
    // https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki
    const blockHeightEncoded = bitcoinjs.script.number.encode(
      jobTemplate.blockData.height,
    );

    // Get the length of the block height encoding
    const blockHeightLengthByte = Buffer.from([blockHeightEncoded.length]);

    // Generate padding and take length of encode blockHeight into account
    const padding = Buffer.alloc(8 + (3 - blockHeightEncoded.length), 0);

    // Build the script
    let script = Buffer.concat([
      blockHeightLengthByte,
      blockHeightEncoded,
      extra,
      padding,
    ]);
    // Check if the pool identifier is too long
    if (script.length > MAX_SCRIPT_SIZE) {
      console.warn('Pool identifier is too long, removing the pool identifier');
      script = Buffer.concat([
        blockHeightLengthByte,
        blockHeightEncoded,
        padding,
      ]);
    }

    this.coinbaseTransaction.ins[0].script = script;
    const bootstrapCoinbaseMessageEnabled =
      `${
        configService.get('BOOTSTRAP_COINBASE_MESSAGE_ENABLED') ?? 'false'
      }`.toLowerCase() === 'true';
    const bootstrapCoinbaseMessage = `${
      configService.get('BOOTSTRAP_COINBASE_MESSAGE') ?? ''
    }`;
    const bootstrapCoinbaseMessageHeightMax = Number.parseInt(
      `${configService.get('BOOTSTRAP_COINBASE_MESSAGE_HEIGHT_MAX') ?? '1'}`,
      10,
    );
    const shouldAttachBootstrapMessage =
      bootstrapCoinbaseMessageEnabled &&
      bootstrapCoinbaseMessage.length > 0 &&
      Number.isFinite(bootstrapCoinbaseMessageHeightMax) &&
      jobTemplate.blockData.height <= bootstrapCoinbaseMessageHeightMax;

    if (shouldAttachBootstrapMessage) {
      this.coinbaseTransaction.addOutput(
        bitcoinjs.script.compile([
          bitcoinjs.opcodes.OP_RETURN,
          Buffer.from(bootstrapCoinbaseMessage, 'utf8'),
        ]),
        0,
      );
    }

    if (
      this.chainProfile.enableSegwit &&
      jobTemplate.block.witnessCommit != null
    ) {
      // 0x6a24aa21a9ed + 32-byte witness commitment payload
      const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
      this.coinbaseTransaction.addOutput(
        bitcoinjs.script.compile([
          bitcoinjs.opcodes.OP_RETURN,
          Buffer.concat([segwitMagicBits, jobTemplate.block.witnessCommit]),
        ]),
        0,
      );
    }

    // Check if the pool identifier is too long
    if (
      this.coinbaseTransaction.weight() + jobTemplate.block.weight() >
      MAX_BLOCK_WEIGHT
    ) {
      console.warn(
        'Block weight exceeds the maximum allowed weight, removing the pool identifier',
      );
      const script = Buffer.concat([
        blockHeightLengthByte,
        blockHeightEncoded,
        padding,
      ]);
      this.coinbaseTransaction.ins[0].script = script;
    }

    this.rebuildCoinbaseParts();
  }

  public applySignedCoinbase(
    signedCoinbase: bitcoinjs.Transaction,
    lock: { extraNonce2: string; ntime: number; versionMask?: number },
  ) {
    this.coinbaseTransaction = bitcoinjs.Transaction.fromBuffer(
      signedCoinbase.toBuffer(),
    );
    this.signetLocked = true;
    this.lockedExtraNonce2 = lock.extraNonce2.toLowerCase();
    this.lockedNtime = lock.ntime;
    this.lockedVersionMask = lock.versionMask ?? 0;
    this.rebuildCoinbaseParts();
  }

  public matchesLockedSubmission(
    extraNonce2: string,
    ntime: number,
    versionMask: number,
  ): boolean {
    if (!this.signetLocked) {
      return true;
    }

    return (
      this.lockedExtraNonce2 === extraNonce2.toLowerCase() &&
      this.lockedNtime === ntime &&
      this.lockedVersionMask === versionMask
    );
  }

  private rebuildCoinbaseParts() {
    const privateSerializer = (
      this.coinbaseTransaction as unknown as {
        __toBuffer?: () => Buffer;
      }
    ).__toBuffer;
    const serializedCoinbaseTx =
      privateSerializer == null
        ? this.coinbaseTransaction.toBuffer().toString('hex')
        : privateSerializer.call(this.coinbaseTransaction).toString('hex');

    const inputScript = this.coinbaseTransaction.ins[0].script.toString('hex');

    const partOneIndex =
      serializedCoinbaseTx.indexOf(inputScript) + inputScript.length;

    this.coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex - 16);
    this.coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);
  }

  public copyAndUpdateBlock(
    jobTemplate: IJobTemplate,
    versionMask: number,
    nonce: number,
    extraNonce: string,
    extraNonce2: string,
    timestamp: number,
  ): bitcoinjs.Block {
    const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
    testBlock.transactions = jobTemplate.block.transactions.map((tx) => {
      return Object.assign(new bitcoinjs.Transaction(), tx);
    });

    testBlock.transactions[0] = this.coinbaseTransaction;

    testBlock.nonce = nonce;

    // recompute version mask
    if (versionMask !== undefined && versionMask != 0) {
      testBlock.version = testBlock.version ^ versionMask;
    }

    // set the nonces
    const nonceScript = testBlock.transactions[0].ins[0].script.toString('hex');

    testBlock.transactions[0].ins[0].script = Buffer.from(
      `${nonceScript.substring(
        0,
        nonceScript.length - 16,
      )}${extraNonce}${extraNonce2}`,
      'hex',
    );

    //recompute the root since we updated the coinbase script with the nonces
    testBlock.merkleRoot = this.calculateMerkleRootHash(
      testBlock.transactions[0].getHash(false),
      jobTemplate.merkle_branch,
    );

    testBlock.timestamp = timestamp;

    return testBlock;
  }

  private calculateMerkleRootHash(
    newRoot: Buffer,
    merkleBranches: string[],
  ): Buffer {
    const bothMerkles = Buffer.alloc(64);

    bothMerkles.set(newRoot);

    for (let i = 0; i < merkleBranches.length; i++) {
      bothMerkles.set(Buffer.from(merkleBranches[i], 'hex'), 32);
      newRoot = bitcoinjs.crypto.hash256(bothMerkles);
      bothMerkles.set(newRoot);
    }

    return bothMerkles.subarray(0, 32);
  }

  private createCoinbaseTransaction(
    addresses: AddressObject[],
    reward: number,
  ): bitcoinjs.Transaction {
    // Part 1
    const coinbaseTransaction = new bitcoinjs.Transaction();

    // Set the version of the transaction
    coinbaseTransaction.version = 2;

    // Add the coinbase input (input with no previous output)
    coinbaseTransaction.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

    // Add an output
    let rewardBalance = reward;

    addresses.forEach((recipientAddress) => {
      const amount = Math.floor((recipientAddress.percent / 100) * reward);
      rewardBalance -= amount;
      coinbaseTransaction.addOutput(
        this.getPaymentScript(recipientAddress.address),
        amount,
      );
    });

    //Add any remaining sats from the Math.floor
    coinbaseTransaction.outs[0].value += rewardBalance;

    if (this.chainProfile.enableSegwit) {
      const segwitWitnessReservedValue = Buffer.alloc(32, 0);
      // For segwit-enabled chains, coinbase input witness contains the reserved value.
      coinbaseTransaction.ins[0].witness = [segwitWitnessReservedValue];
    }

    return coinbaseTransaction;
  }

  private getPaymentScript(address: string): Buffer {
    try {
      return toHcashOutputScript(address);
    } catch {
      throw new Error(
        `Invalid ${getActiveChainProfile().ticker} payout address: ${address}`,
      );
    }
  }

  public response(jobTemplate: IJobTemplate): string {
    const miningTime =
      this.signetLocked && this.lockedNtime != null
        ? this.lockedNtime
        : jobTemplate.block.timestamp;

    const job: IMiningNotify = {
      id: null,
      method: eResponseMethod.MINING_NOTIFY,
      params: [
        this.jobId,
        this.swapEndianWords(jobTemplate.block.prevHash).toString('hex'),
        this.coinbasePart1,
        this.coinbasePart2,
        jobTemplate.merkle_branch,
        jobTemplate.block.version.toString(16),
        jobTemplate.block.bits.toString(16),
        miningTime.toString(16).padStart(8, '0'),
        jobTemplate.blockData.clearJobs,
      ],
    };

    return JSON.stringify(job) + '\n';
  }

  private swapEndianWords(buffer: Buffer): Buffer {
    const swappedBuffer = Buffer.alloc(buffer.length);

    for (let i = 0; i < buffer.length; i += 4) {
      swappedBuffer[i] = buffer[i + 3];
      swappedBuffer[i + 1] = buffer[i + 2];
      swappedBuffer[i + 2] = buffer[i + 1];
      swappedBuffer[i + 3] = buffer[i];
    }

    return swappedBuffer;
  }
}
