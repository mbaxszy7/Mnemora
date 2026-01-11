import type {
  CaptureCompleteEvent,
  CaptureErrorEvent,
  CaptureSchedulerStateEvent,
  CaptureStartEvent,
  PreferencesChangedEvent,
  CaptureSchedulerEvent,
  CaptureSchedulerEventHandler,
  CaptureSchedulerEventPayload,
} from "./types";

export type {
  CaptureCompleteEvent,
  CaptureErrorEvent,
  CaptureSchedulerStateEvent,
  CaptureStartEvent,
  PreferencesChangedEvent,
  CaptureSchedulerEvent,
  CaptureSchedulerEventHandler,
  CaptureSchedulerEventPayload,
};

export interface ScreenCaptureEventMap {
  "capture:start": CaptureStartEvent;
  "capture:complete": CaptureCompleteEvent;
  "capture:error": CaptureErrorEvent;
  "capture-scheduler:state": CaptureSchedulerStateEvent;
  "preferences:changed": PreferencesChangedEvent;
}
