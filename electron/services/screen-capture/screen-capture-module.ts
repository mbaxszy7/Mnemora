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
import { WindowFilter } from "./window-filter";
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
  WindowFilterConfig,
} from "./types";
import { DEFAULT_SCHEDULER_CONFIG, DEFAULT_CAPTURE_OPTIONS } from "./types";
import { getLogger } from "../logger";
import { powerMonitorService } from "../power-monitor";

// Use global to persist instance across hot reloads
// This ensures we can properly clean up the old instance when the module is reloaded
declare global {
  var __screenCaptureModuleInstance: ScreenCaptureModule | null;
}

// Clean up existing instance on hot reload
if (globalThis.__screenCaptureModuleInstance) {
  const logger = getLogger("screen-capture-module");
  logger.info("Hot reload detected, disposing old ScreenCaptureModule instance");
  globalThis.__screenCaptureModuleInstance.dispose();
  globalThis.__screenCaptureModuleInstance = null;
}

/**
 * Configuration options for ScreenCaptureModule
 */
export interface ScreenCaptureModuleOptions {
  /** Scheduler configuration */
  scheduler?: Partial<SchedulerConfig>;
  /** Capture options */
  capture?: Partial<CaptureOptions>;
  /** Window filter configuration */
  filter?: Partial<WindowFilterConfig>;
  /** Cache refresh interval in milliseconds */
  cacheInterval?: number;
}

/**
 * ScreenCaptureModule provides a unified interface for screen capture functionality.
 * It initializes all components and wires them together.
 */
export class ScreenCaptureModule {
  // Use getter/setter to sync with global variable for hot reload support
  private static get instance(): ScreenCaptureModule | null {
    return globalThis.__screenCaptureModuleInstance ?? null;
  }
  private static set instance(value: ScreenCaptureModule | null) {
    globalThis.__screenCaptureModuleInstance = value;
  }

  private readonly sourceProvider: CaptureSourceProvider;
  private readonly windowFilter: WindowFilter;
  private readonly captureService: CaptureService;
  private readonly scheduler: ScreenCaptureScheduler;
  private readonly captureOptions: CaptureOptions;
  private readonly logger = getLogger("screen-capture-module");
  private disposed = false;

  private constructor(options: ScreenCaptureModuleOptions = {}) {
    this.logger.info("Initializing ScreenCaptureModule");

    // Initialize components
    this.sourceProvider = new CaptureSourceProvider({
      cacheInterval: options.cacheInterval,
      immediate: true,
      onError: (error) => this.logger.error({ error }, "Source provider cache error"),
    });

    this.windowFilter = new WindowFilter(options.filter);
    this.captureService = new CaptureService();
    this.captureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...options.capture };

    // Create scheduler with capture task
    this.scheduler = new ScreenCaptureScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, ...options.scheduler },
      () => this.executeCaptureTask()
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
  static getInstance(options?: ScreenCaptureModuleOptions): ScreenCaptureModule {
    const logger = getLogger("screen-capture-module");
    if (!ScreenCaptureModule.instance) {
      logger.info("Creating new ScreenCaptureModule instance");
      ScreenCaptureModule.instance = new ScreenCaptureModule(options);
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

    // Get current window list from cache (already filtered by windowFilter)
    const windows = this.getWindows();
    const screens = this.getScreens();

    // Log window information with each capture
    const appNames = [...new Set(windows.map((w) => this.windowFilter.getDisplayAppName(w)))];
    this.logger.info(
      {
        screenCount: screens.length,
        windowCount: windows.length,
        activeApps: appNames,
      },
      "Current window list at capture time"
    );

    // Capture all screens (stitched if multiple monitors)
    const result = await this.captureService.captureScreens(this.captureOptions);

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
    return this.windowFilter.filterSystemWindows(windows);
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
export function getScreenCaptureModule(options?: ScreenCaptureModuleOptions): ScreenCaptureModule {
  return ScreenCaptureModule.getInstance(options);
}
