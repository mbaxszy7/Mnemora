/**
 * Activity Alert Trace Buffer
 *
 * In-memory ring buffer + EventEmitter for surfacing "Activity" pipeline issues
 * in the Monitoring Dashboard (Performance Monitor).
 *
 * Data flow:
 * - Producers call `activityAlertBuffer.record(...)`.
 * - `MonitoringServer` reads recent alerts for SSE init payload and streams
 *   new alerts to the dashboard via `type: "activity_alert"`.
 * - Alerts are NOT persisted to database.
 *
 * Main trigger points (sources):
 * - `activity-monitor-service.ts`
 *   - Activity summary waited too long for `text` semaphore (semaphore wait).
 *   - Activity summary timed out (AbortError from LLM request).
 *   - Activity summary overdue because window is ready but VLM progress is still pending.
 *   - Event details waited too long for `text` semaphore.
 *   - Event details timed out.
 * - `activity-timeline-scheduler.ts`
 *   - Stale `running` activity summary / event details tasks were recovered to `pending`
 *     (indicates stuck execution).
 */

import { EventEmitter } from "events";

import { RingBuffer } from "./ring-buffer";
import type { ActivityAlertEvent } from "./monitoring-types";

class ActivityAlertBuffer extends EventEmitter {
  private buffer: RingBuffer<ActivityAlertEvent>;

  constructor(capacity: number) {
    super();
    this.buffer = new RingBuffer<ActivityAlertEvent>(capacity);
  }

  record(event: ActivityAlertEvent): void {
    this.buffer.push(event);
    this.emit("alert", event);
  }

  getRecent(count: number): ActivityAlertEvent[] {
    return this.buffer.getRecent(count).reverse();
  }

  clear(): void {
    this.buffer.clear();
  }
}

export const activityAlertBuffer = new ActivityAlertBuffer(100);
