import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

const SEGWIT_WITNESS_MAGIC = Buffer.from('aa21a9ed', 'hex');
const SIGNET_HEADER = Buffer.from('ecc7daa2', 'hex');
const SIGHASH_ALL = bitcoinjs.Transaction.SIGHASH_ALL;

@Injectable()
export class SignetBlockSigningService {
  private readonly enabled: boolean;
  private readonly privateKey: Buffer | null;
  private readonly challengeScript: Buffer | null;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      `${
        this.configService.get('ENABLE_SIGNET_BLOCK_SIGNING') ?? 'true'
      }`.toLowerCase() === 'true';

    const keyHex = `${
      this.configService.get('SIGNET_BLOCK_PRIVATE_KEY_HEX') ?? ''
    }`.trim();
    if (keyHex.length === 0) {
      if (this.enabled) {
        throw new Error(
          'ENABLE_SIGNET_BLOCK_SIGNING=true requires SIGNET_BLOCK_PRIVATE_KEY_HEX',
        );
      }
      this.privateKey = null;
      this.challengeScript = null;
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error('SIGNET_BLOCK_PRIVATE_KEY_HEX must be 32-byte hex');
    }

    this.privateKey = Buffer.from(keyHex, 'hex');
    if (!ecc.isPrivate(this.privateKey)) {
      throw new Error(
        'SIGNET_BLOCK_PRIVATE_KEY_HEX is not a valid secp256k1 private key',
      );
    }
    const publicKey = Buffer.from(ecc.pointFromScalar(this.privateKey, true));
    this.challengeScript = bitcoinjs.script.compile([
      publicKey,
      bitcoinjs.opcodes.OP_CHECKSIG,
    ]);
  }

  public getChallengeScriptHex(): string | null {
    return this.challengeScript == null
      ? null
      : this.challengeScript.toString('hex');
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public signBlock(
    block: bitcoinjs.Block,
    signetChallengeHex?: string,
  ): bitcoinjs.Block {
    if (!this.enabled) {
      return block;
    }
    if (this.privateKey == null || this.challengeScript == null) {
      throw new Error(
        'Signet block signing is enabled but SIGNET_BLOCK_PRIVATE_KEY_HEX is missing',
      );
    }
    if (signetChallengeHex == null || signetChallengeHex.length === 0) {
      throw new Error(
        'Signet block signing requires signet_challenge from getblocktemplate',
      );
    }
    const expected = this.challengeScript.toString('hex');
    if (signetChallengeHex.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `Signet challenge mismatch. Expected ${expected}, got ${signetChallengeHex}`,
      );
    }

    const baseBlock = this.cloneBlock(block);
    if (baseBlock.transactions.length === 0) {
      throw new Error(
        'Cannot sign signet block without a coinbase transaction',
      );
    }

    const witnessOutputIndex = this.findWitnessCommitmentOutputIndex(
      baseBlock.transactions[0],
    );
    if (witnessOutputIndex < 0) {
      throw new Error(
        'Cannot sign signet block: missing witness commitment output',
      );
    }

    const coinbaseWithHeader = bitcoinjs.Transaction.fromBuffer(
      baseBlock.transactions[0].toBuffer(),
    );
    coinbaseWithHeader.outs[witnessOutputIndex].script = this.appendPushData(
      coinbaseWithHeader.outs[witnessOutputIndex].script,
      SIGNET_HEADER,
    );

    const blockWithHeader = this.cloneBlock(baseBlock);
    blockWithHeader.transactions[0] = coinbaseWithHeader;
    blockWithHeader.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(
      blockWithHeader.transactions,
      false,
    );

    const signetData = this.serializeSignetData(blockWithHeader);
    const signedInputScript = this.buildSignedInputScript(signetData);
    const signetSolution = Buffer.concat([
      this.serializeCompactSize(signedInputScript.length),
      signedInputScript,
      Buffer.from([0x00]), // empty witness stack
    ]);

    const finalCoinbase = bitcoinjs.Transaction.fromBuffer(
      baseBlock.transactions[0].toBuffer(),
    );
    finalCoinbase.outs[witnessOutputIndex].script = this.appendPushData(
      finalCoinbase.outs[witnessOutputIndex].script,
      Buffer.concat([SIGNET_HEADER, signetSolution]),
    );

    const signedBlock = this.cloneBlock(baseBlock);
    signedBlock.transactions[0] = finalCoinbase;
    signedBlock.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(
      signedBlock.transactions,
      false,
    );
    return signedBlock;
  }

  private buildSignedInputScript(signetData: Buffer): Buffer {
    const toSpend = new bitcoinjs.Transaction();
    toSpend.version = 0;
    toSpend.locktime = 0;
    toSpend.addInput(
      Buffer.alloc(32, 0),
      0xffffffff,
      0,
      bitcoinjs.script.compile([bitcoinjs.opcodes.OP_0, signetData]),
    );
    toSpend.addOutput(this.challengeScript, 0);

    const spend = new bitcoinjs.Transaction();
    spend.version = 0;
    spend.locktime = 0;
    spend.addInput(toSpend.getHash(), 0, 0, Buffer.alloc(0));
    spend.addOutput(bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN]), 0);

    const digest = spend.hashForSignature(0, this.challengeScript, SIGHASH_ALL);
    const signature = Buffer.from(ecc.sign(digest, this.privateKey));
    const signatureWithType = bitcoinjs.script.signature.encode(
      signature,
      SIGHASH_ALL,
    );
    return bitcoinjs.script.compile([signatureWithType]);
  }

  private serializeSignetData(block: bitcoinjs.Block): Buffer {
    const signetData = Buffer.alloc(72);
    signetData.writeInt32LE(block.version, 0);
    block.prevHash.copy(signetData, 4);
    block.merkleRoot.copy(signetData, 36);
    signetData.writeUInt32LE(block.timestamp, 68);
    return signetData;
  }

  private appendPushData(script: Buffer, data: Buffer): Buffer {
    return Buffer.concat([script, bitcoinjs.script.compile([data])]);
  }

  private findWitnessCommitmentOutputIndex(
    coinbase: bitcoinjs.Transaction,
  ): number {
    for (let i = 0; i < coinbase.outs.length; i++) {
      const chunks = bitcoinjs.script.decompile(coinbase.outs[i].script);
      if (chunks == null || chunks.length < 2) {
        continue;
      }
      if (chunks[0] !== bitcoinjs.opcodes.OP_RETURN) {
        continue;
      }
      const dataChunk = chunks.find(
        (chunk) => Buffer.isBuffer(chunk) && chunk.length >= 36,
      ) as Buffer;
      if (
        dataChunk != null &&
        dataChunk.subarray(0, 4).equals(SEGWIT_WITNESS_MAGIC)
      ) {
        return i;
      }
    }
    return -1;
  }

  private cloneBlock(block: bitcoinjs.Block): bitcoinjs.Block {
    const cloned = Object.assign(new bitcoinjs.Block(), block);
    cloned.prevHash = Buffer.from(block.prevHash);
    cloned.merkleRoot =
      block.merkleRoot == null ? null : Buffer.from(block.merkleRoot);
    cloned.transactions = block.transactions.map((tx) =>
      bitcoinjs.Transaction.fromBuffer(tx.toBuffer()),
    );
    return cloned;
  }

  private serializeCompactSize(value: number): Buffer {
    if (value < 253) {
      return Buffer.from([value]);
    }
    if (value <= 0xffff) {
      const b = Buffer.alloc(3);
      b[0] = 253;
      b.writeUInt16LE(value, 1);
      return b;
    }
    if (value <= 0xffffffff) {
      const b = Buffer.alloc(5);
      b[0] = 254;
      b.writeUInt32LE(value, 1);
      return b;
    }
    throw new Error('CompactSize overflow');
  }
}
