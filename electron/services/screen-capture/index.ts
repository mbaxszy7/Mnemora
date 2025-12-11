/**
 * Screen Capture Module - Public API
 *
 * This module provides the unified interface for screen capture functionality.
 * External code should only use exports from this file.
 */

// Main module facade - the primary interface for screen capture
export { ScreenCaptureModule, getScreenCaptureModule } from "./screen-capture-module";
export type { ScreenCaptureModuleOptions } from "./screen-capture-module";

// Storage utilities used by main.ts
export { cleanupDevCaptures } from "./storage-service";

// Types needed by IPC handlers
export type { SchedulerConfig, SchedulerState, CaptureSource } from "./types";
