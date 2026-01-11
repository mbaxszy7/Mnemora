import { describe, it, expect } from "vitest";

import type { SchedulerLane } from "./base-scheduler";
import { BaseScheduler } from "./base-scheduler";

class TestScheduler extends BaseScheduler {
  protected getDefaultIntervalMs(): number {
    return 0;
  }

  protected getMinDelayMs(): number {
    return 0;
  }

  protected computeEarliestNextRun(): number | null {
    return null;
  }

  protected async runCycle(): Promise<void> {
    return;
  }

  async runProcessInLanes<T>(options: {
    lanes: Record<SchedulerLane, T[]>;
    concurrency: number;
    laneWeights?: Partial<Record<SchedulerLane, number>>;
    maxItems?: number;
    handler: (item: T, lane: SchedulerLane) => Promise<void>;
  }): Promise<void> {
    await this.processInLanes(options);
  }
}

describe("BaseScheduler.processInLanes", () => {
  it("should dispatch realtime work before recovery when realtime is available", async () => {
    const scheduler = new TestScheduler();
    const order: Array<string> = [];

    const lanes = {
      realtime: ["r1", "r2"],
      recovery: Array.from({ length: 10 }, (_, i) => `b${i + 1}`),
    } satisfies Record<SchedulerLane, string[]>;

    await scheduler.runProcessInLanes({
      lanes,
      concurrency: 1,
      laneWeights: { realtime: 3, recovery: 1 },
      handler: async (item, lane) => {
        order.push(`${lane}:${item}`);
      },
    });

    expect(order[0]).toBe("realtime:r1");
    expect(order[1]).toBe("realtime:r2");
    expect(order[2]?.startsWith("recovery:")).toBe(true);
  });
});
