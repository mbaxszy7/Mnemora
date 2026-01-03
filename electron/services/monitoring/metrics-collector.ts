import { EventEmitter } from "events";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "perf_hooks";
import { getLogger } from "../logger";
import { RingBuffer } from "./ring-buffer";
import {
  type MetricsSnapshot,
  type HealthSummary,
  type HealthIndicator,
  DEFAULT_MONITORING_CONFIG,
  HEALTH_THRESHOLDS,
  getHealthLevel,
} from "./monitoring-types";

const logger = getLogger("metrics-collector");

/**
 * MetricsCollector
 *
 * Low-frequency sampling service for main process performance metrics.
 * Uses Node.js perf_hooks for event loop monitoring.
 *
 * Features:
 * - Event loop lag (via monitorEventLoopDelay histogram)
 * - Event loop utilization (0-1)
 * - CPU usage (process.cpuUsage)
 * - Memory usage (process.memoryUsage)
 * - Automatic health level calculation
 *
 * Usage:
 *   metricsCollector.start();
 *   metricsCollector.on('metrics', (snapshot) => { ... });
 *   metricsCollector.stop();
 */
export class MetricsCollector extends EventEmitter {
  private static instance: MetricsCollector | null = null;

  private interval: NodeJS.Timeout | null = null;
  private buffer: RingBuffer<MetricsSnapshot>;
  private lagMonitor: IntervalHistogram | null = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime: number = 0;
  private intervalMs: number;
  private running: boolean = false;

  // For dynamic throttling based on event loop pressure
  private minIntervalMs: number = 1000;
  private maxIntervalMs: number = 10000;

  private constructor() {
    super();
    this.intervalMs = DEFAULT_MONITORING_CONFIG.metricsIntervalMs;
    this.buffer = new RingBuffer<MetricsSnapshot>(DEFAULT_MONITORING_CONFIG.bufferSize);
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  /**
   * Start collecting metrics at the specified interval
   */
  start(intervalMs?: number): void {
    if (this.running) {
      logger.debug("MetricsCollector already running");
      return;
    }

    this.intervalMs = intervalMs ?? DEFAULT_MONITORING_CONFIG.metricsIntervalMs;
    this.running = true;

    // Initialize event loop delay monitor
    // Resolution of 20ms is good enough for our purposes
    this.lagMonitor = monitorEventLoopDelay({ resolution: 20 });
    this.lagMonitor.enable();

    // Initialize CPU baseline
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();

    // Start sampling
    this.scheduleNextSample();

    logger.info({ intervalMs: this.intervalMs }, "MetricsCollector started");
  }

  /**
   * Stop collecting metrics
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
    }

    if (this.lagMonitor) {
      this.lagMonitor.disable();
      this.lagMonitor = null;
    }

    logger.info("MetricsCollector stopped");
  }

  /**
   * Get recent metrics from buffer (oldest to newest)
   */
  getRecentMetrics(count?: number): MetricsSnapshot[] {
    if (count === undefined) {
      return this.buffer.toArray();
    }
    // getRecent returns newest first, so reverse to get oldest first
    return this.buffer.getRecent(count).reverse();
  }

  /**
   * Get current health summary based on latest metrics
   */
  getHealthSummary(): HealthSummary {
    const latest = this.buffer.getLast();
    const ts = Date.now();

    if (!latest) {
      // Return default healthy state if no metrics yet
      return {
        ts,
        eventLoopLag: {
          level: "healthy",
          value: 0,
          threshold: HEALTH_THRESHOLDS.eventLoopLagMs,
        },
        eventLoopUtilization: {
          level: "healthy",
          value: 0,
          threshold: HEALTH_THRESHOLDS.eventLoopUtilization,
        },
        cpu: {
          level: "healthy",
          value: 0,
          threshold: HEALTH_THRESHOLDS.cpuUsagePercent,
        },
        memory: {
          level: "healthy",
          value: 0,
          threshold: HEALTH_THRESHOLDS.memoryUsagePercent,
        },
        queueBacklog: {
          level: "healthy",
          value: 0,
          threshold: HEALTH_THRESHOLDS.queueBacklog,
        },
      };
    }

    // Calculate memory usage percentage (heap used / heap total)
    const memoryPercent =
      latest.memoryHeapTotal > 0 ? (latest.memoryHeapUsed / latest.memoryHeapTotal) * 100 : 0;

    return {
      ts,
      eventLoopLag: this.createHealthIndicator(
        latest.eventLoopLagP95Ms,
        HEALTH_THRESHOLDS.eventLoopLagMs
      ),
      eventLoopUtilization: this.createHealthIndicator(
        latest.eventLoopUtilization,
        HEALTH_THRESHOLDS.eventLoopUtilization
      ),
      cpu: this.createHealthIndicator(latest.cpuUsagePercent, HEALTH_THRESHOLDS.cpuUsagePercent),
      memory: this.createHealthIndicator(memoryPercent, HEALTH_THRESHOLDS.memoryUsagePercent),
      queueBacklog: {
        level: "healthy", // Will be updated by QueueInspector
        value: 0,
        threshold: HEALTH_THRESHOLDS.queueBacklog,
      },
    };
  }

  /**
   * Check if collector is currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  private scheduleNextSample(): void {
    if (!this.running) return;

    this.interval = setTimeout(() => {
      this.collectSample();
      this.scheduleNextSample();
    }, this.intervalMs);
  }

  private collectSample(): void {
    try {
      const ts = Date.now();
      const snapshot = this.createSnapshot(ts);

      this.buffer.push(snapshot);
      this.emit("metrics", snapshot);

      // Dynamic throttling: if event loop is stressed, increase interval
      this.adjustIntervalIfNeeded(snapshot.eventLoopLagP95Ms);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to collect metrics sample"
      );
    }
  }

  private createSnapshot(ts: number): MetricsSnapshot {
    // Event loop lag percentiles (nanoseconds -> ms)
    let eventLoopLagP50Ms = 0;
    let eventLoopLagP95Ms = 0;
    if (this.lagMonitor) {
      eventLoopLagP50Ms = this.lagMonitor.percentile(50) / 1e6;
      eventLoopLagP95Ms = this.lagMonitor.percentile(95) / 1e6;
      // Reset histogram for next interval
      this.lagMonitor.reset();
    }

    // Event loop utilization
    const elu = performance.eventLoopUtilization();
    const eventLoopUtilizationValue = elu.utilization;

    // CPU usage (calculate delta since last sample)
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage ?? undefined);
    const elapsedMs = ts - this.lastCpuTime;
    const cpuUsagePercent =
      elapsedMs > 0
        ? ((currentCpuUsage.user + currentCpuUsage.system) / 1000 / elapsedMs) * 100
        : 0;

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = ts;

    // Memory usage
    const memUsage = process.memoryUsage();

    return {
      ts,
      eventLoopLagP50Ms,
      eventLoopLagP95Ms,
      eventLoopUtilization: eventLoopUtilizationValue,
      cpuUsagePercent: Math.min(100, Math.max(0, cpuUsagePercent)),
      memoryRss: memUsage.rss,
      memoryHeapUsed: memUsage.heapUsed,
      memoryHeapTotal: memUsage.heapTotal,
    };
  }

  private createHealthIndicator(
    value: number,
    threshold: { warning: number; critical: number }
  ): HealthIndicator {
    return {
      level: getHealthLevel(value, threshold),
      value,
      threshold,
    };
  }

  private adjustIntervalIfNeeded(lagMs: number): void {
    // If lag is high, slow down sampling to reduce pressure
    if (lagMs > HEALTH_THRESHOLDS.eventLoopLagMs.critical) {
      const newInterval = Math.min(this.intervalMs * 2, this.maxIntervalMs);
      if (newInterval !== this.intervalMs) {
        this.intervalMs = newInterval;
        logger.debug({ newInterval, lagMs }, "Increased sampling interval due to high lag");
      }
    } else if (lagMs < HEALTH_THRESHOLDS.eventLoopLagMs.warning * 0.5) {
      // If lag is low, can speed up sampling (but not below min)
      const newInterval = Math.max(
        this.intervalMs / 2,
        this.minIntervalMs,
        DEFAULT_MONITORING_CONFIG.metricsIntervalMs
      );
      if (newInterval !== this.intervalMs) {
        this.intervalMs = newInterval;
        logger.debug({ newInterval, lagMs }, "Decreased sampling interval due to low lag");
      }
    }
  }
}

export const metricsCollector = MetricsCollector.getInstance();
