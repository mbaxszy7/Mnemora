/**
 * Monitoring Types
 *
 * Shared types for performance monitoring, health status, and error events.
 * Used by MetricsCollector, MonitoringServer, and SSE streaming.
 */

// ============================================================================
// Health Status Types
// ============================================================================

export type HealthLevel = "healthy" | "warning" | "critical";

export interface HealthIndicator {
  level: HealthLevel;
  value: number;
  threshold: { warning: number; critical: number };
}

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Core metrics snapshot captured at regular intervals
 */
export interface MetricsSnapshot {
  ts: number; // timestamp in ms
  eventLoopLagP50Ms: number; // event loop delay p50 in ms
  eventLoopLagP95Ms: number; // event loop delay p95 in ms
  eventLoopUtilization: number; // 0-1, from perf_hooks.eventLoopUtilization()
  cpuUsagePercent: number; // 0-100
  memoryRss: number; // bytes
  memoryHeapUsed: number; // bytes
  memoryHeapTotal: number; // bytes
}

/**
 * Queue status for pipeline processing queues
 * Used by MonitoringServer to track backlog and health
 */
export interface QueueStatus {
  ts: number;
  /** VLM processing queue (batches.vlmStatus) */
  batchesVlm: { pending: number; running: number; failed: number };
  /** OCR processing queue (screenshots.ocrStatus) */
  screenshotsOcr: { pending: number; running: number; failed: number };
  /** Thread LLM processing queue (batches.threadLlmStatus) */
  batchesThreadLlm: { pending: number; running: number; failed: number };
  /** Vector document queues (embedding + index) */
  vectorDocuments: {
    embeddingPending: number;
    embeddingRunning: number;
    indexPending: number;
    indexRunning: number;
    failed: number;
  };
  /** Activity summary generation queue */
  activitySummaries: { pending: number; running: number; failed: number };
  /** Activity event details generation queue (user-triggered) */
  activityEventDetails: { pending: number; running: number; failed: number };
}

/**
 * AI error event from LLM usage tracking
 */
export interface AIErrorEvent {
  ts: number;
  capability: "vlm" | "text" | "embedding";
  operation: string;
  model: string;
  errorCode: string | null;
}

/**
 * AI request trace for monitoring dashboard (not persisted)
 */
export interface AIRequestTrace {
  ts: number;
  capability: "vlm" | "text" | "embedding";
  operation: string;
  model: string;
  durationMs: number;
  status: "succeeded" | "failed";
  responsePreview?: string;
  errorPreview?: string;
  images?: string[]; // Base64 data URLs
}

export type ActivityAlertKind =
  | "activity_summary_overdue"
  | "activity_summary_semaphore_wait"
  | "activity_summary_stuck_running"
  | "activity_summary_timeout"
  | "activity_event_details_semaphore_wait"
  | "activity_event_details_stuck_running"
  | "activity_event_details_timeout";

export interface ActivityAlertEvent {
  ts: number;
  kind: ActivityAlertKind;
  message: string;
  windowStart?: number;
  windowEnd?: number;
  eventId?: number;
  waitMs?: number;
  nextRunAt?: number | null;
  updatedAt?: number;
}

// ============================================================================
// SSE Streaming Types
// ============================================================================

export type SSEMessageType =
  | "metrics"
  | "queue"
  | "ai_error"
  | "ai_request"
  | "health"
  | "init"
  | "activity_alert";

export interface SSEMessage {
  type: SSEMessageType;
  data:
    | MetricsSnapshot
    | QueueStatus
    | AIErrorEvent
    | AIRequestTrace
    | ActivityAlertEvent
    | HealthSummary
    | InitPayload;
}

export interface HealthSummary {
  ts: number;
  eventLoopLag: HealthIndicator;
  eventLoopUtilization: HealthIndicator;
  cpu: HealthIndicator;
  memory: HealthIndicator;
  queueBacklog: HealthIndicator;
}

export interface InitPayload {
  recentMetrics: MetricsSnapshot[];
  recentQueue: QueueStatus | null;
  recentErrors: AIErrorEvent[];
  recentActivityAlerts: ActivityAlertEvent[];
  health: HealthSummary;
}

// ============================================================================
// Server Configuration
// ============================================================================

export interface MonitoringServerConfig {
  preferredPort: number;
  maxPortAttempts: number;
  metricsIntervalMs: number;
  queueIntervalMs: number;
  maxClientsPerConnection: number;
  maxClientQueueSize: number;
  bufferSize: number;
}

export const DEFAULT_MONITORING_CONFIG: MonitoringServerConfig = {
  preferredPort: 23333,
  maxPortAttempts: 10,
  metricsIntervalMs: 2000,
  queueIntervalMs: 5000,
  maxClientsPerConnection: 10,
  maxClientQueueSize: 1,
  bufferSize: 300, // ~10 minutes of data at 2s interval
};

// ============================================================================
// Health Thresholds
// ============================================================================

export const HEALTH_THRESHOLDS = {
  eventLoopLagMs: { warning: 50, critical: 200 },
  eventLoopUtilization: { warning: 0.7, critical: 0.9 },
  cpuUsagePercent: { warning: 70, critical: 90 },
  memoryUsagePercent: { warning: 70, critical: 90 },
  queueBacklog: { warning: 50, critical: 200 },
} as const;

/**
 * Calculate health level based on value and thresholds
 */
export function getHealthLevel(
  value: number,
  thresholds: { warning: number; critical: number }
): HealthLevel {
  if (value >= thresholds.critical) return "critical";
  if (value >= thresholds.warning) return "warning";
  return "healthy";
}
