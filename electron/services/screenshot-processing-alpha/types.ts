import type { VlmStatus } from "../../database/schema";

export type { VlmStatus };

export type {
  ExpandedContextNode,
  ScreenshotEvidence,
  SearchQuery,
  SearchResult,
} from "@shared/context-types";

export type SourceKey = `screen:${string}` | `window:${string}`;

export function isValidSourceKey(key: string): key is SourceKey {
  return key.startsWith("screen:") || key.startsWith("window:");
}

export interface ScreenshotMeta {
  appHint?: string;
  windowTitle?: string;
  width?: number;
  height?: number;
  bytes?: number;
  mime?: string;
}

export interface AcceptedScreenshot {
  id: number;
  ts: number;
  sourceKey: SourceKey;
  phash: string;
  filePath: string;
  meta: ScreenshotMeta;
}

export interface HistoryThreadSummary {
  threadId: string;
  title: string;
  lastEventSummary: string;
  lastEventTs: number;
}

export interface SegmentSummary {
  segmentId: string;
  summary: string;
  sourceKey: SourceKey;
  startTs: number;
}

export interface HistoryPack {
  recentThreads: HistoryThreadSummary[];
  openSegments: SegmentSummary[];
  recentEntities: string[];
}

export interface Batch {
  batchId: string;
  sourceKey: SourceKey;
  screenshots: AcceptedScreenshot[];
  tsStart: number;
  tsEnd: number;
}
