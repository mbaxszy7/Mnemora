/**
 * ScreenCaptureModule - Unified facade for screen capture functionality
 *
 * Architecture:
 * - Uses dependency injection for loose coupling and testability
 * - Delegates to specialized services for specific functionality
 * - Provides unified API for screen capture operations
 *
 * Services:
 * - CaptureSourceProvider: Provides access to capture sources with caching
 * - CaptureService: Handles actual screen capture with multi-monitor support
 * - ScreenCaptureScheduler: Manages the capture scheduling loop
 * - CapturePreferencesService: Manages user preferences for capture sources
 */

import { CaptureSourceProvider } from "./capture-source-provider";
import { CaptureService } from "./capture-service";
import { ScreenCaptureScheduler } from "./capture-scheduler";

import { saveCaptureToFile, cleanupOldCaptures } from "./capture-storage";
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
import { permissionService } from "../permission-service";
import { llmConfigService } from "../llm-config-service";
import { CapturePreferencesService } from "../capture-preferences-service";

const isDev = !!process.env["VITE_DEV_SERVER_URL"];

/**
 * ScreenCaptureModule provides a unified interface for screen capture functionality.
 */
export class ScreenCaptureModule {
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

    this.sourceProvider = new CaptureSourceProvider({
      immediate: true,
      onError: (error) => this.logger.error({ error }, "Source provider cache error"),
    });
    this.captureService = new CaptureService();
    this.preferencesService = new CapturePreferencesService();
    this.scheduler = new ScreenCaptureScheduler(DEFAULT_SCHEDULER_CONFIG, () =>
      this.executeCaptureTask()
    );

    this.setupPowerMonitorCallbacks();
    this.logger.info("ScreenCaptureModule initialized");
  }

  // ============================================================================
  // Singleton Management
  // ============================================================================

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
   * Reset the singleton instance (for dev hot reload)
   */
  static resetInstance(): void {
    if (ScreenCaptureModule.instance) {
      ScreenCaptureModule.instance.dispose();
      ScreenCaptureModule.instance = null;
    }
  }

  /**
   * Try to initialize and start screen capture if permissions are granted
   * Call this after user grants permissions
   */
  static async tryInitialize() {
    const logger = getLogger("screen-capture-module");

    if (!permissionService.hasScreenRecordingPermission()) {
      logger.info("Screen recording permission not granted, skipping initialization");
      return false;
    }

    if (!permissionService.hasAccessibilityPermission()) {
      logger.info("Accessibility permission not granted, skipping initialization");
      return false;
    }

    const llmConfig = await llmConfigService.loadConfiguration();

    if (!llmConfig && !isDev) {
      logger.info("LLM config not saved, skipping initialization ");
      return false;
    }

    try {
      const module = ScreenCaptureModule.getInstance();
      module.start();
      logger.info("Screen capture module initialized and started");
      return true;
    } catch (error) {
      logger.error({ error }, "Failed to initialize screen capture module");
      return false;
    }
  }

  // ============================================================================
  // System Event Handlers
  // ============================================================================

  private setupPowerMonitorCallbacks(): void {
    powerMonitorService.registerSuspendCallback(() => {
      if (this.getState().status === "running") {
        this.pause();
        this.logger.info("Screen capture paused on system suspend");
      }
    });

    powerMonitorService.registerResumeCallback(() => {
      if (this.getState().status === "paused") {
        this.resume();
        this.logger.info("Screen capture resumed on system resume");
      }
    });

    powerMonitorService.registerLockScreenCallback(() => {
      if (this.getState().status === "running") {
        this.pause();
        this.logger.info("Screen capture paused on screen lock");
      }
    });

    powerMonitorService.registerUnlockScreenCallback(() => {
      if (this.getState().status === "paused") {
        this.resume();
        this.logger.info("Screen capture resumed on screen unlock");
      }
    });

    this.logger.debug("Power monitor callbacks registered");
  }

  // ============================================================================
  // Capture Task Execution
  // ============================================================================

  /**
   * Execute the capture task - called by the scheduler on each cycle
   * Returns the first CaptureResult for scheduler compatibility
   */
  private async executeCaptureTask(): Promise<CaptureResult> {
    this.logger.debug("Executing capture task");

    // Ensure source provider has data
    await this.ensureSourcesAvailable();

    // Get current sources and preferences
    const captureSources = this.sourceProvider.getSources();
    const effectiveSources = this.preferencesService.getEffectiveCaptureSources(captureSources);

    this.logger.info(
      {
        selectedApps: effectiveSources.selectedApps.map((app) => app.name),
        selectedScreens: effectiveSources.selectedScreens.map((screen) => screen.displayId),
      },
      "Effective capture sources"
    );

    let results: CaptureResult[];

    // Determine capture mode based on user preferences
    const hasSelectedApps = effectiveSources.selectedApps.length > 0;

    if (hasSelectedApps) {
      // Window capture mode: user selected specific apps
      // this.logger.info(
      //   { appNames: effectiveSources.selectedApps },
      //   "Using window capture mode for selected apps"
      // );
      results = await this.captureService.captureWindowsByApp(
        effectiveSources,
        this.captureOptions
      );

      // If no windows found, fall back to screen capture
      if (results.length === 0) {
        this.logger.error(
          { hasSelectedApps },
          "No windows found for selected apps, no screenshots captured"
        );
      }
    } else {
      results = await this.captureService.captureScreens({
        ...this.captureOptions,
        selectedScreenIds: effectiveSources.selectedScreens.map((screen) => screen.displayId),
      });
    }

    // Save all captures to disk
    await this.saveCapturesToDisk(results);

    // Return first result for scheduler compatibility
    return results[0];
  }

  private async ensureSourcesAvailable(): Promise<void> {
    if (!this.sourceProvider.getSources().length) {
      this.logger.debug("Source provider cache empty, triggering refresh");
      try {
        await this.sourceProvider.refresh();
      } catch (error) {
        this.logger.warn({ error }, "Source provider refresh failed, continuing with empty cache");
      }
    }
  }

  private async saveCapturesToDisk(results: CaptureResult[]): Promise<void> {
    for (const result of results) {
      try {
        const filepath = await saveCaptureToFile(
          result.source,
          result.buffer,
          result.timestamp,
          this.captureOptions.format
        );
        this.logger.debug({ filepath }, "Capture saved to disk");
      } catch (error) {
        this.logger.error({ error }, "Failed to save capture to disk");
      }
    }
  }

  // ============================================================================
  // Public API: Scheduler Control
  // ============================================================================

  start(): void {
    if (this.disposed) {
      this.logger.warn("Cannot start disposed module");
      return;
    }
    this.logger.info("Starting scheduler");
    this.scheduler.start();
  }

  stop(): void {
    this.logger.info("Stopping scheduler");
    this.scheduler.stop();
  }

  pause(): void {
    this.logger.info("Pausing scheduler");
    this.scheduler.pause();
  }

  resume(): void {
    if (this.disposed) {
      this.logger.warn("Cannot resume disposed module");
      return;
    }
    this.logger.info("Resuming scheduler");
    this.scheduler.resume();
  }

  getState(): SchedulerState {
    return this.scheduler.getState();
  }

  updateConfig(config: Partial<SchedulerConfig>): void {
    this.logger.info({ config }, "Updating scheduler config");
    this.scheduler.updateConfig(config);
  }

  // ============================================================================
  // Public API: Event Subscription
  // ============================================================================

  on<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void {
    this.scheduler.on(event, handler);
  }

  off<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void {
    this.scheduler.off(event, handler);
  }

  // ============================================================================
  // Public API: Source Access
  // ============================================================================

  // getSources(): CaptureSource[] {
  //   return this.sourceProvider.getSources();
  // }

  // getScreens(): CaptureSource[] {
  //   return this.sourceProvider.getScreens();
  // }

  // getWindows(): CaptureSource[] {
  //   const windows = this.sourceProvider.getWindows();
  //   return windowFilter.filterSystemWindows(windows);
  // }

  // async refreshSources(): Promise<void> {
  //   await this.sourceProvider.refresh();
  // }

  // ============================================================================
  // Public API: Capture Operations
  // ============================================================================

  async captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult[]> {
    return this.captureService.captureScreens({ ...this.captureOptions, ...options });
  }

  async cleanupOldCaptures(maxAge?: number, maxCount?: number): Promise<number> {
    return cleanupOldCaptures(maxAge, maxCount);
  }

  // ============================================================================
  // Public API: Service Access (for IPC handlers)
  // ============================================================================

  getCaptureService(): CaptureService {
    return this.captureService;
  }

  getPreferencesService(): CapturePreferencesService {
    return this.preferencesService;
  }

  // ============================================================================
  // Public API: Lifecycle
  // ============================================================================

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.logger.info("Disposing ScreenCaptureModule");
    this.disposed = true;

    this.scheduler.stop();
    this.sourceProvider.dispose();

    this.logger.info("ScreenCaptureModule disposed");
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

// Export singleton getter for convenience
export function getScreenCaptureModule(): ScreenCaptureModule {
  return ScreenCaptureModule.getInstance();
}
