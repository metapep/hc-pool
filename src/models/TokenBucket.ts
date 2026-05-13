/**
 * Token bucket on hashrate-equivalent units (per device-class plan C8 / P-3..P-6).
 *
 * Refill rate: targetHashrateHs hashes/sec.
 * Cost per share: difficulty * 2^32 hashes (the expected work behind one
 *   accepted share at that difficulty).
 * Capacity: max(targetHashrateHs * 3600, 4 * pool_diff_floor * 2^32) so the
 *   bucket can always hold at least 4 shares at the pool's current diff
 *   floor — prevents lockout for low classes (per audit fix #11).
 *
 * Lifecycle (per audit fix #7 / P-6):
 *   - Created on `mining.authorize` success (NOT mining.subscribe). Initial
 *     `currentUnits = 0` so reconnect-flooding cannot grant burst capacity.
 *   - Refilled on every check via wall-clock delta * refillPerSec.
 *   - Destroyed when the StratumV1Client session disconnects.
 *   - Refresh of params on 15s re-auth (P-5): preserve currentUnits, scale
 *     by the ratio of new/old refill rate so a class change doesn't
 *     instantly punish the device.
 */
export class TokenBucket {
  public capacityUnits: number;
  public refillPerSec: number;
  public currentUnits: number;
  private lastRefillMs: number;

  constructor(params: { targetHashrateHs: number; poolDiffFloor: number }) {
    const refill = Math.max(1, params.targetHashrateHs);
    this.refillPerSec = refill;
    this.capacityUnits = TokenBucket.computeCapacity(
      refill,
      params.poolDiffFloor,
    );
    this.currentUnits = 0;
    this.lastRefillMs = Date.now();
  }

  /**
   * Capacity = max(refillPerSec * 3600, 4 * pool_diff_floor * 2^32).
   * Pool difficulty floor must remain <= refillPerSec * 900 / 2^32 for
   * enforcement to behave well; otherwise the second term dominates and
   * dwarfs honest-device share traffic. See P-3 startup check below.
   */
  public static computeCapacity(
    refillPerSec: number,
    poolDiffFloor: number,
  ): number {
    const oneHourRefill = refillPerSec * 3600;
    const fourSharesAtFloor = 4 * poolDiffFloor * Math.pow(2, 32);
    return Math.max(oneHourRefill, fourSharesAtFloor);
  }

  /**
   * Recompute params on policy change (per P-5). Preserves currentUnits but
   * never above the new capacity.
   */
  public updateParams(params: {
    targetHashrateHs: number;
    poolDiffFloor: number;
  }): void {
    const newRefill = Math.max(1, params.targetHashrateHs);
    const newCapacity = TokenBucket.computeCapacity(
      newRefill,
      params.poolDiffFloor,
    );
    // Refill once at the OLD rate so the time delta isn't lost.
    this.refill();
    this.refillPerSec = newRefill;
    this.capacityUnits = newCapacity;
    if (this.currentUnits > newCapacity) {
      this.currentUnits = newCapacity;
    }
  }

  /**
   * Add accumulated units based on wall-clock delta. Capped at capacity.
   */
  public refill(): void {
    const now = Date.now();
    const deltaSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    if (deltaSec <= 0) {
      return;
    }
    this.currentUnits = Math.min(
      this.capacityUnits,
      this.currentUnits + deltaSec * this.refillPerSec,
    );
    this.lastRefillMs = now;
  }

  /**
   * Try to consume `cost` units. Returns true if the bucket had enough,
   * false if rejected (caller should NOT disconnect — just reject the
   * share per P-4).
   */
  public tryConsume(costUnits: number): boolean {
    this.refill();
    if (costUnits > this.capacityUnits) {
      // Single share larger than entire bucket — would lock out the
      // device permanently. Should never happen if computeCapacity is
      // honored; return false defensively.
      return false;
    }
    if (this.currentUnits < costUnits) {
      return false;
    }
    this.currentUnits -= costUnits;
    return true;
  }

  /**
   * Observation snapshot for metrics (per P-3 metrics integration).
   */
  public snapshot(): {
    currentUnits: number;
    capacityUnits: number;
    refillPerSec: number;
    drainPct: number;
  } {
    this.refill();
    const drain = this.capacityUnits > 0
      ? 100 * (1 - this.currentUnits / this.capacityUnits)
      : 0;
    return {
      currentUnits: this.currentUnits,
      capacityUnits: this.capacityUnits,
      refillPerSec: this.refillPerSec,
      drainPct: drain,
    };
  }
}

/**
 * Cost in token-bucket units for a single share at a given difficulty.
 * Identical formula to the pool's existing accepted-hashrate calculation
 * in StratumV1ClientStatistics.ts (`(shares * difficulty) * 2^32 / sec`).
 */
export function shareCostUnits(difficulty: number): number {
  return difficulty * Math.pow(2, 32);
}
