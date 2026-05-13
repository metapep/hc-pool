import { Injectable } from '@nestjs/common';

type FailureRecord = {
  stage: string;
  reason: string;
  count: number;
};

@Injectable()
export class MiningSessionMetricsService {
  private readonly authFailures = new Map<string, number>();
  private readonly stageFailures = new Map<string, Map<string, number>>();
  private readonly stageSuccesses = new Map<string, number>();

  public recordFailure(stage: string, reason: string): void {
    const key = `${stage}:${reason}`;
    this.authFailures.set(key, (this.authFailures.get(key) ?? 0) + 1);

    const stageMap = this.stageFailures.get(stage) ?? new Map<string, number>();
    stageMap.set(reason, (stageMap.get(reason) ?? 0) + 1);
    this.stageFailures.set(stage, stageMap);
  }

  public recordSuccess(stage: string): void {
    this.stageSuccesses.set(stage, (this.stageSuccesses.get(stage) ?? 0) + 1);
  }

  public snapshot(): {
    totalFailures: number;
    failures: FailureRecord[];
    successes: { stage: string; count: number }[];
  } {
    const failures: FailureRecord[] = [];
    let totalFailures = 0;

    for (const [stage, reasons] of this.stageFailures.entries()) {
      for (const [reason, count] of reasons.entries()) {
        totalFailures += count;
        failures.push({ stage, reason, count });
      }
    }

    const successes = [...this.stageSuccesses.entries()].map(
      ([stage, count]) => ({
        stage,
        count,
      }),
    );

    failures.sort((a, b) => b.count - a.count);
    successes.sort((a, b) => b.count - a.count);

    return {
      totalFailures,
      failures,
      successes,
    };
  }

  // Per device-class plan P-3 metrics integration. Counters are tagged
  // by classId and (for rejections) whether enforcement was actually
  // active — observe-only mode still increments the rejection counter
  // so operators can see what would have happened pre-rollout.
  private readonly bucketAccept = new Map<string, number>();
  private readonly bucketReject = new Map<string, number>();
  private readonly bucketRejectObserveOnly = new Map<string, number>();

  public recordBucketAcceptance(
    deviceId: string | undefined,
    classId: string | null,
  ): void {
    const key = `${classId ?? 'unknown'}|${deviceId ?? 'unknown'}`;
    this.bucketAccept.set(key, (this.bucketAccept.get(key) ?? 0) + 1);
  }

  public recordBucketRejection(
    deviceId: string | undefined,
    classId: string | null,
    enforcementActive: boolean,
  ): void {
    const key = `${classId ?? 'unknown'}|${deviceId ?? 'unknown'}`;
    if (enforcementActive) {
      this.bucketReject.set(key, (this.bucketReject.get(key) ?? 0) + 1);
    } else {
      this.bucketRejectObserveOnly.set(
        key,
        (this.bucketRejectObserveOnly.get(key) ?? 0) + 1,
      );
    }
  }

  public bucketSnapshot(): {
    acceptedTotal: number;
    rejectedEnforced: number;
    rejectedObserveOnly: number;
    perDevice: Array<{
      classId: string;
      deviceId: string;
      accepted: number;
      rejectedEnforced: number;
      rejectedObserveOnly: number;
    }>;
  } {
    const keys = new Set<string>([
      ...this.bucketAccept.keys(),
      ...this.bucketReject.keys(),
      ...this.bucketRejectObserveOnly.keys(),
    ]);
    const perDevice = [...keys].map((key) => {
      const [classId, deviceId] = key.split('|', 2);
      return {
        classId,
        deviceId,
        accepted: this.bucketAccept.get(key) ?? 0,
        rejectedEnforced: this.bucketReject.get(key) ?? 0,
        rejectedObserveOnly: this.bucketRejectObserveOnly.get(key) ?? 0,
      };
    });
    return {
      acceptedTotal: [...this.bucketAccept.values()].reduce(
        (a, b) => a + b,
        0,
      ),
      rejectedEnforced: [...this.bucketReject.values()].reduce(
        (a, b) => a + b,
        0,
      ),
      rejectedObserveOnly: [...this.bucketRejectObserveOnly.values()].reduce(
        (a, b) => a + b,
        0,
      ),
      perDevice,
    };
  }
}
