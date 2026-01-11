import { getLogger } from "../logger";

const logger = getLogger("base-scheduler");

// SchedulerLane is an intentional, high-level classification for fairness:
// - realtime: freshly generated work we want to keep responsive
// - recovery: historical backlog / retry work that should make progress but not starve realtime
export type SchedulerLane = "realtime" | "recovery";

export abstract class BaseScheduler {
  protected timer: NodeJS.Timeout | null = null;
  protected isRunning = false;
  protected isProcessing = false;
  protected wakeRequested = false;

  /**
   * Process items from multiple lanes using a weighted fair strategy.
   *
   * Why this exists:
   * - Our AI semaphores (vlm/text/embedding) are FIFO. The earlier you *start* a task,
   *   the earlier it enters the semaphore waiting queue.
   * - If a cycle starts with a huge recovery backlog, it can enqueue ahead of new tasks,
   *   making realtime work feel "stuck" even though it is due.
   *
   * How it works:
   * - Callers split items into `realtime` and `recovery` queues.
   * - We pick the next lane by weighted round-robin (`laneWeights`).
   *   Example: { realtime: 3, recovery: 1 } => realtime,realtime,realtime,recovery, ...
   * - We run up to `concurrency` workers; each worker repeatedly pulls the next item and
   *   calls `handler(item, lane)`.
   *
   * Note:
   * - This is cooperative fairness, not preemption: it won't reorder tasks already waiting
   *   inside a semaphore queue, but it improves the enqueue order for new work.
   */
  protected async processInLanes<TItem>(options: {
    lanes: Record<SchedulerLane, TItem[]>;
    concurrency: number;
    laneWeights?: Partial<Record<SchedulerLane, number>>;
    maxItems?: number;
    handler: (item: TItem, lane: SchedulerLane) => Promise<void>;
    onError?: (error: unknown, item: TItem, lane: SchedulerLane) => void;
  }): Promise<void> {
    const laneOrder: SchedulerLane[] = ["realtime", "recovery"];
    const laneWeights: Record<SchedulerLane, number> = {
      realtime: Math.max(1, Math.floor(options.laneWeights?.realtime ?? 1)),
      recovery: Math.max(1, Math.floor(options.laneWeights?.recovery ?? 1)),
    };

    const sequence: SchedulerLane[] = [];
    for (const lane of laneOrder) {
      for (let i = 0; i < laneWeights[lane]; i++) {
        sequence.push(lane);
      }
    }

    const totalItems = options.lanes.realtime.length + options.lanes.recovery.length;
    const maxItems =
      options.maxItems == null
        ? totalItems
        : Math.max(0, Math.min(totalItems, Math.floor(options.maxItems)));

    const concurrency = Math.max(1, Math.floor(options.concurrency));
    const workerCount = Math.min(concurrency, maxItems);
    if (workerCount <= 0) {
      return;
    }

    let seqCursor = 0;
    let dispatched = 0;

    const takeNext = (): { item: TItem; lane: SchedulerLane } | null => {
      if (dispatched >= maxItems) {
        return null;
      }

      // Preferred path: follow the weighted sequence so realtime gets more "turns"
      // when both lanes have work.
      for (let tries = 0; tries < sequence.length; tries++) {
        const lane = sequence[seqCursor % sequence.length];
        seqCursor++;
        const q = options.lanes[lane];
        if (q.length > 0) {
          const item = q.shift() as TItem;
          dispatched++;
          return { item, lane };
        }
      }

      // Fallback: if the weighted lane we picked is empty, take whatever is available.
      for (const lane of laneOrder) {
        const q = options.lanes[lane];
        if (q.length > 0) {
          const item = q.shift() as TItem;
          dispatched++;
          return { item, lane };
        }
      }

      return null;
    };

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const next = takeNext();
        if (!next) {
          return;
        }

        try {
          await options.handler(next.item, next.lane);
        } catch (error) {
          if (options.onError) {
            options.onError(error, next.item, next.lane);
          } else {
            logger.error(
              { error, scheduler: this.constructor.name, lane: next.lane },
              "Unhandled error in lane worker"
            );
          }
        }
      }
    });

    await Promise.all(workers);
  }

  protected clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  protected scheduleSoon(): void {
    this.clearTimer();
    if (!this.isRunning) return;

    this.timer = setTimeout(() => {
      void this.runCycle().catch((error) => {
        logger.error(
          { error, scheduler: this.constructor.name },
          "Unhandled error (Promise rejection) in scheduler cycle"
        );
      });
    }, this.getSoonDelayMs());
  }

  protected scheduleNext(): void {
    this.clearTimer();
    if (!this.isRunning) return;
    // 计算下一次需要执行的最早时间（nextRunAt），用于动态调度下一轮 cycle

    // 防 tight loop：即使任务已经 due（earliestNextRun <= now）或者马上 due，
    // 也至少等待一个最小间隔再跑下一轮。
    // 这样可以显著降低 CPU/DB 压力，并给 VLM/embedding 等异步流水线留出推进时间。

    // 如果有 earliestNextRun，则把 delay clamp 到 [minDelayMs, defaultIntervalMs]。
    // - 不会因为 due task 导致 0ms/1s 紧循环
    // - 也不会 sleep 超过默认周期（防止调度“睡过头”）

    let earliestNextRun: number | null;
    try {
      earliestNextRun = this.computeEarliestNextRun();
    } catch (error) {
      logger.warn(
        { error, scheduler: this.constructor.name },
        "Failed to compute earliest next run; falling back to default interval"
      );
      earliestNextRun = null;
    }
    const now = Date.now();

    const defaultIntervalMs = this.getDefaultIntervalMs();
    const minDelayMs = this.getMinDelayMs();

    let delayMs: number;
    if (earliestNextRun !== null) {
      delayMs = Math.min(Math.max(earliestNextRun - now, minDelayMs), defaultIntervalMs);
    } else {
      delayMs = defaultIntervalMs;
    }

    this.timer = setTimeout(() => {
      void this.runCycle().catch((error) => {
        logger.error(
          { error, scheduler: this.constructor.name },
          "Unhandled error (Promise rejection) in scheduler cycle"
        );
      });
    }, delayMs);

    try {
      this.onScheduledNext(delayMs, earliestNextRun);
    } catch (error) {
      logger.warn(
        { error, scheduler: this.constructor.name },
        "Unhandled error thrown by onScheduledNext hook"
      );
    }
  }

  protected getSoonDelayMs(): number {
    return 1000;
  }

  protected onScheduledNext(_delayMs: number, _earliestNextRun: number | null): void {
    void _delayMs;
    void _earliestNextRun;
  }

  protected abstract getDefaultIntervalMs(): number;
  protected abstract getMinDelayMs(): number;
  protected abstract computeEarliestNextRun(): number | null;
  protected abstract runCycle(): Promise<void>;
}
