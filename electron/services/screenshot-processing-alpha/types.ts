import { type VlmStatus } from "../../database/schema";

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

export interface VlmScreenshotInput {
  id: number;
  ts: number;
  sourceKey: string;
  filePath: string | null;
  appHint: string | null;
  windowTitle: string | null;
}

export interface VlmBatchInput {
  batchId: string;
  sourceKey: string;
  screenshots: VlmScreenshotInput[];
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

export interface PendingBatchRecord {
  id: number;
  batchId: string;
  sourceKey: string;
  screenshotIds: number[];
  tsStart: number;
  tsEnd: number;
  vlmAttempts: number;
  updatedAt: number;
}

export interface AppContextPayload {
  appHint: string | null;
  windowTitle: string | null;
  sourceKey: string;
}

export interface KnowledgePayload {
  contentType: string;
  sourceUrl?: string;
  projectOrLibrary?: string;
  keyInsights: string[];
  language: "en" | "zh" | "other";
  textRegion?: {
    box: {
      top: number;
      left: number;
      width: number;
      height: number;
    };
    description?: string;
    confidence: number;
  };
}

export interface StateSnapshotPayload {
  subjectType: string;
  subject: string;
  currentState: string;
  metrics?: Record<string, string | number>;
  issue?: {
    detected: boolean;
    type: "error" | "bug" | "blocker" | "question" | "warning";
    description: string;
    severity: number;
  };
}

export interface UpsertNodeInput {
  batchId: number;
  screenshotId: number;
  screenshotTs: number;
  title: string;
  summary: string;
  appContext: AppContextPayload;
  knowledge: KnowledgePayload | null;
  stateSnapshot: StateSnapshotPayload | null;
  uiTextSnippets: string[];
  keywords: string[];
  importance: number;
  confidence: number;
}
