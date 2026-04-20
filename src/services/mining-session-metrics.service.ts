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
}
