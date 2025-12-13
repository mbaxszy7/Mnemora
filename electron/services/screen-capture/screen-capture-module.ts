/**
 * ScreenCaptureModule - Unified facade for screen capture functionality
 *
 * This module initializes and wires together all screen capture components:
 * - CaptureSourceProvider: Provides access to capture sources with caching
 * - WindowFilter: Filters system windows and normalizes app names
 * - CaptureService: Handles actual screen capture with multi-monitor support
 * - ScreenCaptureScheduler: Manages the capture scheduling loop
 *
 * Requirements: All (integration of all components)
 */

import { CaptureSourceProvider } from "./capture-source-provider";
import { windowFilter } from "./window-filter";
import { CaptureService } from "./capture-service";
import { ScreenCaptureScheduler } from "./scheduler";
import { saveCaptureToFile, cleanupOldCaptures } from "./storage-service";
import type {
  SchedulerConfig,
  SchedulerState,
  CaptureOptions,
  CaptureResult,
  SchedulerEvent,
  SchedulerEventHandler,
  SchedulerEventPayload,
} from "./types";
import { DEFAULT_SCHEDULER_CONFIG, DEFAULT_CAPTURE_OPTIONS } from "./types";
import { getLogger } from "../logger";
import { powerMonitorService } from "../power-monitor";
import { CapturePreferencesService } from "../capture-preferences-service";

/**
 * ScreenCaptureModule provides a unified interface for screen capture functionality.
 * It initializes all components and wires them together.
 *
 * Uses default configurations from types.ts:
 * - DEFAULT_SCHEDULER_CONFIG: interval=6000ms, minDelay=100ms, autoStart=false
 * - DEFAULT_CAPTURE_OPTIONS: format=jpeg, quality=80, stitchMultiMonitor=true
 * - DEFAULT_CACHE_INTERVAL: 3000ms
 */
export class ScreenCaptureModule {
  // Use getter/setter to sync with global variable for hot reload support
  private static instance: ScreenCaptureModule | null = null;

  private readonly sourceProvider: CaptureSourceProvider;
  private readonly captureService: CaptureService;
  private readonly scheduler: ScreenCaptureScheduler;
  private readonly preferencesService: CapturePreferencesService;
  private readonly captureOptions = DEFAULT_CAPTURE_OPTIONS;
  private readonly logger = getLogger("screen-capture-module");
  private disposed = false;

  private constructor() {
    this.logger.info("Initializing ScreenCaptureModule");

    // Initialize components with default configurations
    this.sourceProvider = new CaptureSourceProvider({
      immediate: true,
      onError: (error) => this.logger.error({ error }, "Source provider cache error"),
    });

    this.captureService = new CaptureService();
    this.preferencesService = new CapturePreferencesService();

    // Create scheduler with capture task using default config
    this.scheduler = new ScreenCaptureScheduler(DEFAULT_SCHEDULER_CONFIG, () =>
      this.executeCaptureTask()
    );

    // Setup power monitor callbacks for auto pause/resume
    this.setupPowerMonitorCallbacks();

    this.logger.info("ScreenCaptureModule initialized");
  }

  /**
   * Setup power monitor callbacks to auto pause/resume on system events
   */
  private setupPowerMonitorCallbacks(): void {
    // Pause on system suspend
    powerMonitorService.registerSuspendCallback(() => {
      if (this.getState().status === "running") {
        this.pause();
        this.logger.info("Screen capture paused on system suspend");
      }
    });

    // Resume on system resume
    powerMonitorService.registerResumeCallback(() => {
      if (this.getState().status === "paused") {
        this.resume();
        this.logger.info("Screen capture resumed on system resume");
      }
    });

    // Pause on screen lock
    powerMonitorService.registerLockScreenCallback(() => {
      if (this.getState().status === "running") {
        this.pause();
        this.logger.info("Screen capture paused on screen lock");
      }
    });

    // Resume on screen unlock
    powerMonitorService.registerUnlockScreenCallback(() => {
      if (this.getState().status === "paused") {
        this.resume();
        this.logger.info("Screen capture resumed on screen unlock");
      }
    });

    this.logger.debug("Power monitor callbacks registered");
  }

  /**
   * Get the singleton instance of ScreenCaptureModule
   */
  static getInstance(): ScreenCaptureModule {
    const logger = getLogger("screen-capture-module");
    if (!ScreenCaptureModule.instance) {
      logger.info("Creating new ScreenCaptureModule instance");
      ScreenCaptureModule.instance = new ScreenCaptureModule();
    }
    return ScreenCaptureModule.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    if (ScreenCaptureModule.instance) {
      ScreenCaptureModule.instance.dispose();
      ScreenCaptureModule.instance = null;
    }
  }

  /**
   * Execute the capture task - called by the scheduler on each cycle
   *
   * This method integrates user preferences for filtering:
   * - Screens: Filter based on selectedScreenIds (using displayId mapping)
   * - Apps: Filter based on selectedAppNames (for VLM analysis metadata)
   *
   * Fallback behavior:
   * - If no selected screens are available, capture all screens
   * - If no selected apps are active, record all apps
   *
   * Requirements: 3.1, 3.3
   */
  private async executeCaptureTask(): Promise<CaptureResult> {
    this.logger.debug("Executing capture task");

    // Ensure source provider has data (may not be ready immediately after init)
    if (!this.sourceProvider.getSources().length) {
      this.logger.debug("Source provider cache empty, triggering refresh");
      try {
        await this.sourceProvider.refresh();
      } catch (error) {
        this.logger.warn({ error }, "Source provider refresh failed, continuing with empty cache");
      }
    }

    // Get screens and windows from cache
    const screens = this.getScreens();
    const windows = this.getWindows();

    // Get available screen IDs (using displayId from CaptureSource)
    // Note: CaptureSourceProvider returns CaptureSource with displayId field
    const availableScreenIds = screens.map((s) => s.displayId || s.id);

    // Get current preferences
    const preferences = this.preferencesService.getPreferences();

    // Compute effective capture sources based on preferences and availability
    const effectiveSources = this.preferencesService.getEffectiveCaptureSources(
      availableScreenIds,
      windows
    );

    // Log detailed preference information for debugging
    this.logger.info(
      {
        preferences: {
          selectedScreenIds: preferences.selectedScreenIds,
          selectedAppNames: preferences.selectedAppNames,
          rememberSelection: preferences.rememberSelection,
        },
        available: {
          screenCount: screens.length,
          screenIds: availableScreenIds,
        },
        effective: {
          screenIds: effectiveSources.screenIds,
          appNames: effectiveSources.appNames,
          screenFallback: effectiveSources.screenFallback,
          appFallback: effectiveSources.appFallback,
        },
      },
      "Capture task - preferences and effective sources"
    );

    // Log fallback mode warnings
    if (effectiveSources.screenFallback) {
      this.logger.warn(
        {
          selectedScreenIds: preferences.selectedScreenIds,
          availableScreenIds,
        },
        "Screen fallback mode: selected screens unavailable, capturing all screens"
      );
    }

    if (effectiveSources.appFallback) {
      this.logger.warn(
        {
          selectedAppNames: preferences.selectedAppNames,
        },
        "App fallback mode: selected apps not active, recording all apps"
      );
    }

    // Capture screens with effective screen IDs filter
    // effectiveSources.screenIds contains the CGDirectDisplayID strings to capture
    // effectiveSources.appNames is metadata for VLM analysis - it indicates
    // which apps the user is interested in, but doesn't affect the actual capture
    const result = await this.captureService.captureScreens({
      ...this.captureOptions,
      screenIds: effectiveSources.screenIds,
    });

    // Attach effective app names to result for VLM analysis
    // This metadata indicates which apps were active and selected during capture
    const captureMetadata = {
      effectiveApps: effectiveSources.appNames,
      appFallback: effectiveSources.appFallback,
      effectiveScreens: effectiveSources.screenIds,
      screenFallback: effectiveSources.screenFallback,
    };

    this.logger.debug({ captureMetadata }, "Capture metadata for VLM analysis");

    // Save capture to disk
    try {
      const filepath = await saveCaptureToFile(
        result.buffer,
        result.timestamp,
        this.captureOptions.format
      );
      this.logger.debug({ filepath }, "Capture saved to disk");
    } catch (error) {
      this.logger.error({ error }, "Failed to save capture to disk");
    }

    this.logger.debug(
      {
        width: result.width,
        height: result.height,
        isComposite: result.isComposite,
        sourceCount: result.sources.length,
      },
      "Capture task completed"
    );

    return result;
  }

  /**
   * Cleanup old captures to manage disk space
   */
  async cleanupOldCaptures(maxAge?: number, maxCount?: number): Promise<number> {
    return cleanupOldCaptures(maxAge, maxCount);
  }

  // ============================================================================
  // Scheduler Control Methods
  // ============================================================================

  /**
   * Start the capture scheduler
   */
  start(): void {
    if (this.disposed) {
      this.logger.warn("Cannot start disposed module");
      return;
    }
    this.logger.info("Starting scheduler");
    this.scheduler.start();
  }

  /**
   * Stop the capture scheduler
   */
  stop(): void {
    this.logger.info("Stopping scheduler");
    this.scheduler.stop();
  }

  /**
   * Pause the capture scheduler
   */
  pause(): void {
    this.logger.info("Pausing scheduler");
    this.scheduler.pause();
  }

  /**
   * Resume the capture scheduler
   */
  resume(): void {
    if (this.disposed) {
      this.logger.warn("Cannot resume disposed module");
      return;
    }
    this.logger.info("Resuming scheduler");
    this.scheduler.resume();
  }

  /**
   * Get the current scheduler state
   */
  getState(): SchedulerState {
    return this.scheduler.getState();
  }

  /**
   * Update scheduler configuration at runtime
   */
  updateConfig(config: Partial<SchedulerConfig>): void {
    this.logger.info({ config }, "Updating scheduler config");
    this.scheduler.updateConfig(config);
  }

  // ============================================================================
  // Event Subscription Methods
  // ============================================================================

  /**
   * Subscribe to scheduler events
   */
  on<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void {
    this.scheduler.on(event, handler);
  }

  /**
   * Unsubscribe from scheduler events
   */
  off<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void {
    this.scheduler.off(event, handler);
  }

  // ============================================================================
  // Source Provider Methods
  // ============================================================================

  /**
   * Get available capture sources (screens and windows)
   */
  getSources() {
    return this.sourceProvider.getSources();
  }

  /**
   * Get available screens only
   */
  getScreens() {
    return this.sourceProvider.getScreens();
  }

  /**
   * Get available windows (filtered)
   */
  getWindows() {
    const windows = this.sourceProvider.getWindows();
    return windowFilter.filterSystemWindows(windows);
  }

  /**
   * Force refresh the source cache
   */
  async refreshSources(): Promise<void> {
    await this.sourceProvider.refresh();
  }

  // ============================================================================
  // Capture Service Methods
  // ============================================================================

  /**
   * Get monitor layout information
   */
  getMonitorLayout() {
    return this.captureService.getMonitorLayout();
  }

  /**
   * Capture all screens (manual capture, outside of scheduler)
   */
  async captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult> {
    return this.captureService.captureScreens({ ...this.captureOptions, ...options });
  }

  /**
   * Get the capture service instance
   * Allows external access to capture service for IPC handlers
   */
  getCaptureService(): CaptureService {
    return this.captureService;
  }

  // ============================================================================
  // Preferences Methods
  // ============================================================================

  /**
   * Get the preferences service instance
   * Allows external access to preferences for IPC handlers
   */
  getPreferencesService(): CapturePreferencesService {
    return this.preferencesService;
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Dispose all resources and cleanup
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.logger.info("Disposing ScreenCaptureModule");
    this.disposed = true;

    // Stop scheduler first
    this.scheduler.stop();

    // Dispose source provider (stops cache refresh)
    this.sourceProvider.dispose();

    this.logger.info("ScreenCaptureModule disposed");
  }

  /**
   * Check if the module has been disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}

// Export singleton getter for convenience
export function getScreenCaptureModule(): ScreenCaptureModule {
  return ScreenCaptureModule.getInstance();
}
