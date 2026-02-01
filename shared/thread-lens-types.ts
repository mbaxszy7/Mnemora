import type { Thread } from "./context-types";

export interface ActiveThreadState {
  pinnedThreadId: string | null;
  updatedAt: number;
}

export interface ThreadBrief {
  threadId: string;
  lastActiveAt: number;
  briefMarkdown: string;
  highlights: string[];
  currentFocus: string;
  nextSteps: string[];
  updatedAt: number;
}

export interface ThreadLensStateSnapshot {
  revision: number;
  updatedAt: number;
  pinnedThreadId: string | null;
  topThreads: Thread[];
  resolvedThreadId: string | null;
}

export interface ThreadLensStateChangedPayload {
  snapshot: ThreadLensStateSnapshot;
}

export interface ThreadBriefUpdatedPayload {
  threadId: string;
  lastActiveAt: number;
  updatedAt: number;
}

export interface ThreadsThreadIdRequest {
  threadId: string;
}

export interface ThreadsStateResponse {
  state: ActiveThreadState;
}

export interface ThreadsThreadResponse {
  thread: Thread | null;
}

export interface ThreadsThreadsResponse {
  threads: Thread[];
}

export interface ThreadsBriefResponse {
  brief: ThreadBrief | null;
}

export interface ThreadsLensStateResponse {
  snapshot: ThreadLensStateSnapshot;
}

export type ThreadsGetByIdRequest = ThreadsThreadIdRequest;

export interface ThreadsListRequest {
  limit?: number;
}

export type ThreadsPinRequest = ThreadsThreadIdRequest;

export type ThreadsGetActiveStateResponse = ThreadsStateResponse;

export type ThreadsGetActiveCandidatesResponse = ThreadsThreadsResponse;

export type ThreadsGetResolvedActiveResponse = ThreadsThreadResponse;

export type ThreadsGetResponse = ThreadsThreadResponse;

export type ThreadsListResponse = ThreadsThreadsResponse;

export type ThreadsPinResponse = ThreadsStateResponse;

export type ThreadsUnpinResponse = ThreadsStateResponse;

export interface ThreadsGetBriefRequest extends ThreadsThreadIdRequest {
  force?: boolean;
}

export type ThreadsGetBriefResponse = ThreadsBriefResponse;

export type ThreadsMarkInactiveRequest = ThreadsThreadIdRequest;

export type ThreadsMarkInactiveResponse = ThreadsStateResponse;

export type ThreadsGetLensStateResponse = ThreadsLensStateResponse;
