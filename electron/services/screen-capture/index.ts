/**
 * Screen Capture Module - Public API
 *
 * This module provides the unified interface for screen capture functionality.
 * External code should only use exports from this file.
 */

// Main module facade - the primary interface for screen capture
export { screenCaptureModule } from "./screen-capture-module";
export { windowFilter } from "./window-filter";
// Storage utilities used by main.ts
export { cleanupDevCaptures } from "./capture-storage";

// Types needed by IPC handlers
export type { SchedulerConfig, SchedulerState, CaptureSource } from "./types";

export { DEFAULT_SCHEDULER_CONFIG as DefaultCaptureConfig } from "./types";
