export abstract class BaseScheduler {
  protected timer: NodeJS.Timeout | null = null;
  protected isRunning = false;
  protected isProcessing = false;
  protected wakeRequested = false;

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
      void this.runCycle();
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

    const earliestNextRun = this.computeEarliestNextRun();
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
      void this.runCycle();
    }, delayMs);

    this.onScheduledNext(delayMs, earliestNextRun);
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
