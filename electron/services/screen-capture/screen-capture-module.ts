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
import { screenCaptureEventBus } from "./event-bus";

import { saveCaptureToFile, cleanupOldCaptures } from "./capture-storage";
import { BrowserWindow } from "electron";
import type {
  SchedulerConfig,
  CaptureSchedulerState,
  CaptureOptions,
  CaptureResult,
  CaptureSchedulerStateEvent,
  CaptureSchedulerEventHandler,
  PreferencesChangedEvent,
} from "./types";
import { DEFAULT_SCHEDULER_CONFIG, DEFAULT_CAPTURE_OPTIONS } from "./types";
import { getLogger } from "../logger";
import { powerMonitorService } from "../power-monitor";
import { permissionService } from "../permission-service";
import { llmConfigService } from "../llm-config-service";
import { CapturePreferencesService } from "../capture-preferences-service";
import type { CapturePreferences } from "@shared/capture-source-types";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { screenshotProcessingModule } from "../screenshot-processing/screenshot-processing-module";
import { aiRuntimeService } from "../ai-runtime-service";

// const isDev = !!process.env["VITE_DEV_SERVER_URL"];

/**
 * ScreenCaptureModule provides a unified interface for screen capture functionality.
 */
class ScreenCaptureModule {
  private readonly sourceProvider: CaptureSourceProvider;
  private readonly captureService: CaptureService;
  private readonly captureScheduler: ScreenCaptureScheduler;
  private readonly preferencesService: CapturePreferencesService;
  private readonly captureOptions = DEFAULT_CAPTURE_OPTIONS;
  private readonly logger = getLogger("screen-capture-module");
  private disposed = false;
  private processingInitialized = false;

  constructor() {
    this.logger.info("Initializing ScreenCaptureModule");

    this.sourceProvider = new CaptureSourceProvider();
    this.captureService = new CaptureService();
    this.preferencesService = new CapturePreferencesService();
    this.captureScheduler = new ScreenCaptureScheduler(DEFAULT_SCHEDULER_CONFIG, () =>
      this.executeCaptureTask()
    );

    screenCaptureEventBus.on("capture-scheduler:state", this.onSchedulerStateChanged);
    this.setupPowerMonitorCallbacks();
    this.logger.info("ScreenCaptureModule initialized");
  }

  /**
   * Try to initialize and start screen capture if permissions are granted
   * Call this after user grants permissions
   */
  async tryInitialize() {
    if (this.disposed) {
      this.logger.info("Screen capture module disposed, skipping initialization");
      return false;
    }
    const prepared = await this.isCapturePrepared();
    if (!prepared) {
      this.logger.info("Screen capture module not prepared, skipping initialization");
      return false;
    }
    try {
      this.start();
      this.logger.info("Screen capture module initialized and started");
      return true;
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize screen capture module");
      return false;
    }
  }

  private readonly onSchedulerStateChanged: CaptureSchedulerEventHandler<CaptureSchedulerStateEvent> =
    () => {
      const payload = this.getState();
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC_CHANNELS.SCREEN_CAPTURE_STATE_CHANGED, payload);
        }
      } catch {
        // Ignore if BrowserWindow is not available (e.g. tests)
      }
    };

  private async isCapturePrepared(): Promise<boolean> {
    const llmConfig = await llmConfigService.loadConfiguration();
    this.logger.debug(
      { configured: !!llmConfig, mode: llmConfig ? (llmConfig as { mode?: string }).mode : null },
      "LLM config loaded"
    );
    const hasPermissions =
      permissionService.hasScreenRecordingPermission() &&
      permissionService.hasAccessibilityPermission();
    this.logger.info({ hasPermissions }, "Permissions checked");
    return !!hasPermissions && !!llmConfig;
  }

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

  /**
   * Execute the capture task - called by the scheduler on each cycle
   * Returns the first CaptureResult for scheduler compatibility
   */
  private async executeCaptureTask(): Promise<CaptureResult[]> {
    this.logger.debug("Executing capture task");

    const effectiveSources = this.preferencesService.getEffectiveCaptureSources();
    this.logger.debug(
      {
        selectedAppsCount: effectiveSources.selectedApps.length,
        selectedScreensCount: effectiveSources.selectedScreens.length,
      },
      "Effective capture sources"
    );
    let results: CaptureResult[];
    if (effectiveSources.selectedApps.length > 0) {
      const currentSelectedApps = [...effectiveSources.selectedApps];
      // Filter windows to only include those from selected apps
      const selectedAppIds = new Set(currentSelectedApps.map((app) => app.id));
      const apps = await this.sourceProvider.getWindowsSources([...selectedAppIds]);
      const visibleApps = apps.filter((app) => app.isVisible);

      results = await this.captureService.captureWindowsByApp(
        visibleApps.map((app) => app.id),
        this.captureOptions
      );
      if (results.length === 0) {
        this.logger.error(
          { visibleApps },
          "No windows found for selected apps, no screenshots captured"
        );
      }
      results.forEach((result) => {
        const { appName, windowTitle } = currentSelectedApps.find(
          (app) => app.id === result.source.id
        ) || { appName: undefined, windowTitle: undefined };
        result.source = {
          ...result.source,
          appName,
          windowTitle,
        };
      });
    } else {
      results = await this.captureService.captureScreens({
        ...this.captureOptions,
        selectedScreenIds: effectiveSources.selectedScreens.map((screen) => screen.displayId),
      });
    }

    // Save all captures to disk
    await this.saveCapturesToDisk(results);

    return results;
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
        result.filePath = filepath;
        this.logger.debug({ filepath }, "Capture saved to disk");
      } catch (error) {
        this.logger.error({ error }, "Failed to save capture to disk");
      }
    }

    // try {
    //   const deleted = await cleanupOldCaptures(undefined, MAX_CAPTURE_COUNT);
    //   if (deleted > 0) {
    //     this.logger.info({ deleted }, "Cleaned up old captures after save");
    //   }
    // } catch (error) {
    //   this.logger.error({ error }, "Failed to cleanup old captures after save");
    // }
  }

  private initializeProcessingPipeline(): void {
    if (this.disposed) {
      this.logger.warn("Cannot initialize processing pipeline for disposed module");
      return;
    }
    if (this.processingInitialized) {
      return;
    }

    screenshotProcessingModule.initialize({
      screenCapture: this,
    });

    // Ensure processing pipeline sees the current preferences even if they were set
    // before the processing module was initialized.
    const event: PreferencesChangedEvent = {
      type: "preferences:changed",
      timestamp: Date.now(),
      preferences: this.preferencesService.getPreferences(),
    };
    screenCaptureEventBus.emit("preferences:changed", event);
    this.processingInitialized = true;
  }

  start(): void {
    if (this.disposed) {
      this.logger.warn("Cannot start disposed module");
      return;
    }

    this.initializeProcessingPipeline();
    // Reset circuit breaker when starting capture
    aiRuntimeService.resetBreaker();
    this.logger.info("Starting capture scheduler");
    this.captureScheduler.start();
  }

  stop(): void {
    if (this.disposed) {
      this.logger.warn("Cannot stop disposed module");
      return;
    }
    this.logger.info("Stopping scheduler");
    this.captureScheduler.stop();
  }

  pause(): void {
    if (this.disposed) {
      this.logger.warn("Cannot pause disposed module");
      return;
    }
    this.logger.info("Pausing scheduler");
    this.captureScheduler.pause();
  }

  resume(): void {
    if (this.disposed) {
      this.logger.warn("Cannot resume disposed module");
      return;
    }
    this.logger.info("Resuming scheduler");
    this.captureScheduler.resume();
  }

  getState(): CaptureSchedulerState {
    return this.captureScheduler.getState();
  }

  updateConfig(config: Partial<SchedulerConfig>): void {
    this.logger.info({ config }, "Updating scheduler config");
    this.captureScheduler.updateConfig(config);
  }

  async captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult[]> {
    return this.captureService.captureScreens({ ...this.captureOptions, ...options });
  }

  async cleanupOldCaptures(maxAge?: number, maxCount?: number): Promise<number> {
    return cleanupOldCaptures(maxAge, maxCount);
  }

  getCaptureService(): CaptureService {
    return this.captureService;
  }

  getPreferencesService(): CapturePreferencesService {
    return this.preferencesService;
  }

  setPreferences(prefs: Partial<CapturePreferences>): void {
    if (this.disposed) {
      this.logger.warn("Cannot set preferences for disposed module");
      return;
    }
    this.preferencesService.setPreferences(prefs);
    const preferences = this.preferencesService.getPreferences();
    const event: PreferencesChangedEvent = {
      type: "preferences:changed",
      timestamp: Date.now(),
      preferences,
    };
    screenCaptureEventBus.emit("preferences:changed", event);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.logger.info("Disposing ScreenCaptureModule");
    this.disposed = true;

    screenCaptureEventBus.off("capture-scheduler:state", this.onSchedulerStateChanged);
    this.captureScheduler.stop();
    screenshotProcessingModule.dispose();
    this.processingInitialized = false;

    this.logger.info("ScreenCaptureModule disposed");
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

export type ScreenCaptureModuleType = ScreenCaptureModule;

export const screenCaptureModule = new ScreenCaptureModule();
