import Big from 'big.js';
import * as bitcoinjs from 'bitcoinjs-lib';
import { getPowDiff1TargetAsBigInt } from '../network/chain-profile';

export class DifficultyUtils {
  static calculateDifficulty(header: Buffer): {
    submissionDifficulty: number;
    submissionHash: string;
  } {
    const hashResult = bitcoinjs.crypto.hash256(
      Buffer.isBuffer(header) ? header : Buffer.from(header, 'hex'),
    );
    const s64 = DifficultyUtils.le256todouble(hashResult);
    if (s64 === BigInt(0)) {
      return {
        submissionDifficulty: Number.POSITIVE_INFINITY,
        submissionHash: hashResult.toString('hex'),
      };
    }
    const truediffone = Big(getPowDiff1TargetAsBigInt().toString());
    const difficulty = truediffone.div(s64.toString());

    return {
      submissionDifficulty: difficulty.toNumber(),
      submissionHash: hashResult.toString('hex'),
    };
  }

  static calculateDifficultyFromBits(nBits: number): number {
    const mantissa = BigInt(nBits & 0x00ffffff);
    const exponent = (nBits >>> 24) & 0xff;

    if (mantissa === BigInt(0)) {
      return Number.POSITIVE_INFINITY;
    }

    let target: bigint;
    if (exponent <= 3) {
      target = mantissa >> BigInt(8 * (3 - exponent));
    } else {
      target = mantissa << BigInt(8 * (exponent - 3));
    }

    if (target === BigInt(0)) {
      return Number.POSITIVE_INFINITY;
    }

    const maxTarget = getPowDiff1TargetAsBigInt();
    return Big(maxTarget.toString()).div(target.toString()).toNumber();
  }

  private static le256todouble(target: Buffer): bigint {
    const number = target.reduceRight((acc, byte) => {
      return (acc << BigInt(8)) | BigInt(byte);
    }, BigInt(0));
    return number;
  }
}
