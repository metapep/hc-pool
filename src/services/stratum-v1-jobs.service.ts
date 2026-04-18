import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import {
  combineLatest,
  delay,
  filter,
  from,
  interval,
  map,
  Observable,
  shareReplay,
  startWith,
  switchMap,
  tap,
} from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import {
  getActiveChainProfile,
  getPowDiff1TargetAsBigInt,
} from '../network/chain-profile';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {
  block: bitcoinjs.Block;
  merkle_branch: string[];
  blockData: {
    id: string;
    creation: number;
    coinbasevalue: number;
    networkDifficulty: number;
    height: number;
    signetChallenge?: string;
    clearJobs: boolean;
  };
}

@Injectable()
export class StratumV1JobsService {
  private lastIntervalCount: number;
  private skipNext = false;
  private readonly chainProfile = getActiveChainProfile();
  public newMiningJob$: Observable<IJobTemplate>;

  public latestJobId = 1;
  public latestJobTemplateId = 1;

  public jobs: { [jobId: string]: MiningJob } = {};

  public blocks: { [id: number]: IJobTemplate } = {};

  // offset the interval so that all the cluster processes don't try and refresh at the same time.
  private delay =
    process.env.NODE_APP_INSTANCE == null
      ? 0
      : parseInt(process.env.NODE_APP_INSTANCE) * 5000;

  constructor(private readonly bitcoinRpcService: BitcoinRpcService) {
    this.newMiningJob$ = combineLatest([
      this.bitcoinRpcService.newBlock$,
      interval(60000).pipe(delay(this.delay), startWith(-1)),
    ]).pipe(
      switchMap(([miningInfo, interval]) => {
        return from(
          this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks),
        ).pipe(
          map((blockTemplate) => {
            return {
              blockTemplate,
              interval,
            };
          }),
        );
      }),
      map(({ blockTemplate, interval }) => {
        let clearJobs = false;
        if (this.lastIntervalCount === interval) {
          clearJobs = true;
          this.skipNext = true;
          console.log('new block');
        }

        if (this.skipNext == true && clearJobs == false) {
          this.skipNext = false;
          return null;
        }

        this.lastIntervalCount = interval;

        const currentTime = Math.floor(new Date().getTime() / 1000);
        return {
          version: blockTemplate.version,
          bits: parseInt(blockTemplate.bits, 16),
          prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
          transactions: blockTemplate.transactions.map((t) =>
            bitcoinjs.Transaction.fromHex(t.data),
          ),
          coinbasevalue: blockTemplate.coinbasevalue,
          timestamp:
            blockTemplate.mintime > currentTime
              ? blockTemplate.mintime
              : currentTime,
          networkDifficulty: this.calculateNetworkDifficulty(
            parseInt(blockTemplate.bits, 16),
          ),
          signetChallenge: blockTemplate.signet_challenge,
          clearJobs,
          height: blockTemplate.height,
        };
      }),
      filter((next) => next != null),
      map(
        ({
          version,
          bits,
          prevHash,
          transactions,
          timestamp,
          coinbasevalue,
          networkDifficulty,
          signetChallenge,
          clearJobs,
          height,
        }) => {
          const block = new bitcoinjs.Block();

          //create an empty coinbase tx
          const tempCoinbaseTx = new bitcoinjs.Transaction();
          tempCoinbaseTx.version = 2;
          tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
          if (this.chainProfile.enableSegwit) {
            tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
          }
          transactions.unshift(tempCoinbaseTx);

          const transactionBuffers = transactions.map((tx) =>
            tx.getHash(false),
          );

          const merkleTree = merkle(
            transactionBuffers,
            bitcoinjs.crypto.hash256,
          );
          const merkleBranches: Buffer[] = merkleProof(
            merkleTree,
            transactionBuffers[0],
          ).filter((h) => h != null);
          block.merkleRoot = merkleBranches.pop();

          // remove the first (coinbase) and last (root) element from the branch
          const merkle_branch = merkleBranches
            .slice(1, merkleBranches.length)
            .map((b) => b.toString('hex'));

          block.prevHash = prevHash;
          block.version = version;
          block.bits = bits;
          block.timestamp = timestamp;

          block.transactions = transactions;
          if (this.chainProfile.enableSegwit) {
            block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(
              transactions,
              true,
            );
          }

          const id = this.getNextTemplateId();
          this.latestJobTemplateId++;
          return {
            block,
            merkle_branch,
            blockData: {
              id,
              creation: new Date().getTime(),
              coinbasevalue,
              networkDifficulty,
              height,
              signetChallenge,
              clearJobs,
            },
          };
        },
      ),
      tap((data) => {
        if (data.blockData.clearJobs) {
          this.blocks = {};
          this.jobs = {};
        } else {
          const now = new Date().getTime();
          // Delete old templates (5 minutes)
          for (const templateId in this.blocks) {
            if (
              now - this.blocks[templateId].blockData.creation >
              1000 * 60 * 5
            ) {
              delete this.blocks[templateId];
            }
          }
          // Delete old jobs (5 minutes)
          for (const jobId in this.jobs) {
            if (now - this.jobs[jobId].creation > 1000 * 60 * 5) {
              delete this.jobs[jobId];
            }
          }
        }
        this.blocks[data.blockData.id] = data;
      }),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );
  }

  private calculateNetworkDifficulty(nBits: number) {
    const mantissa = BigInt(nBits & 0x007fffff);
    const exponent = (nBits >> 24) & 0xff;

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

  private convertToLittleEndian(hash: string): Buffer {
    const bytes = Buffer.from(hash, 'hex');
    Array.prototype.reverse.call(bytes);
    return bytes;
  }

  public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
    return this.blocks[jobTemplateId];
  }

  public addJob(job: MiningJob) {
    this.jobs[job.jobId] = job;
    this.latestJobId++;
  }

  public getJobById(jobId: string) {
    return this.jobs[jobId];
  }

  public getNextTemplateId() {
    return this.latestJobTemplateId.toString(16);
  }
  public getNextId() {
    return this.latestJobId.toString(16);
  }
}
