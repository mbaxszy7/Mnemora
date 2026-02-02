import type { AIFailureFuseTrippedPayload } from "@shared/ipc-types";

export interface AIFuseTrippedEvent {
  type: "ai-fuse:tripped";
  timestamp: number;
  payload: AIFailureFuseTrippedPayload;
}

export interface AIRuntimeEventMap {
  "ai-fuse:tripped": AIFuseTrippedEvent;
}
