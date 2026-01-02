/**
 * Shared types for Activity Monitor
 * Used by both main process and renderer process
 */

/**
 * Stats object for a 20-min window summary
 */
export interface ActivityStats {
  topApps: string[];
  topEntities?: string[];
  nodeCount: number;
  screenshotCount: number;
  threadCount?: number;
}

/**
 * Timeline window block (20-min)
 * Displayed in the left panel timeline
 */
export interface TimeWindow {
  id: number;
  windowStart: number; // timestamp ms
  windowEnd: number;
  title: string | null;
  status: "pending" | "succeeded" | "failed";
  stats: ActivityStats | null;
}

/**
 * Event kind for categorization
 */
export type ActivityEventKind =
  | "focus"
  | "work"
  | "meeting"
  | "break"
  | "browse"
  | "coding"
  | "unknown";

/**
 * Activity event that can span multiple windows
 */
export interface ActivityEvent {
  id: number;
  eventKey: string;
  title: string;
  kind: ActivityEventKind;
  startTs: number;
  endTs: number;
  durationMs: number;
  isLong: boolean;
  confidence: number;
  importance: number;
  threadId: string | null;
  nodeIds: number[] | null;
  details: string | null; // markdown
  detailsStatus: "pending" | "succeeded" | "failed";
}

/**
 * Full summary for a 20-min window
 * Returned by activity:get-summary
 */
export interface WindowSummary {
  windowStart: number;
  windowEnd: number;
  title: string | null;
  summary: string; // markdown
  highlights: string[] | null;
  stats: ActivityStats | null;
  events: ActivityEvent[];
}

/**
 * Long event marker for timeline display
 */
export interface LongEventMarker {
  id: number;
  title: string;
  kind: ActivityEventKind;
  startTs: number;
  endTs: number;
  durationMs: number;
}

// ============================================================================
// IPC Request/Response Types
// ============================================================================

/**
 * Request payload for activity:get-timeline
 */
export interface TimelineRequest {
  fromTs: number;
  toTs: number;
}

/**
 * Response payload for activity:get-timeline
 */
export interface TimelineResponse {
  windows: TimeWindow[];
  longEvents: LongEventMarker[];
}

export interface ActivityTimelineChangedPayload {
  revision: number;
  fromTs: number;
  toTs: number;
}

/**
 * Request payload for activity:get-summary
 */
export interface SummaryRequest {
  windowStart: number;
  windowEnd: number;
}

/**
 * Response payload for activity:get-summary
 */
export type SummaryResponse = WindowSummary;

/**
 * Request payload for activity:get-event-details
 */
export interface EventDetailsRequest {
  eventId: number;
}

/**
 * Response payload for activity:get-event-details
 */
export type EventDetailsResponse = ActivityEvent;
