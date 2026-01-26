import type { ScreenCaptureModuleType } from "./screen-capture-module";

import { getLogger } from "../logger";
import { userSettingService } from "../user-setting-service";
import { shouldCaptureNow } from "@shared/user-settings-utils";

const logger = getLogger("capture-schedule-controller");

type InitializeArgs = {
  screenCapture: ScreenCaptureModuleType;
  intervalMs?: number;
};

export class CaptureScheduleController {
  private screenCapture: ScreenCaptureModuleType | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 30_000;
  private evaluating = false;
  private pending = false;

  initialize(args: InitializeArgs): void {
    this.screenCapture = args.screenCapture;
    if (args.intervalMs != null) {
      this.intervalMs = args.intervalMs;
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.evaluateNow();
    }, this.intervalMs);

    void this.evaluateNow();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async evaluateNow(): Promise<void> {
    if (this.evaluating) {
      this.pending = true;
      return;
    }

    const screenCapture = this.screenCapture;
    if (!screenCapture) {
      return;
    }

    try {
      this.evaluating = true;
      do {
        this.pending = false;

        const settings = await userSettingService.getSettings();

        const now = new Date();
        const shouldCapture = shouldCaptureNow(settings, now);

        const state = screenCapture.getState();

        if (!shouldCapture) {
          if (state.status === "running") {
            logger.info(
              {
                manualOverride: settings.captureManualOverride,
                captureScheduleEnabled: settings.captureScheduleEnabled,
                captureAllowedWindows: settings.captureAllowedWindows,
              },
              "Schedule disallows capture; pausing"
            );
            screenCapture.pause();
          }
          continue;
        }

        if (state.status === "paused") {
          logger.info(
            {
              manualOverride: settings.captureManualOverride,
              captureScheduleEnabled: settings.captureScheduleEnabled,
            },
            "Schedule allows capture; resuming"
          );
          screenCapture.resume();
          continue;
        }

        if (state.status === "idle" || state.status === "stopped") {
          logger.info(
            {
              status: state.status,
              manualOverride: settings.captureManualOverride,
              captureScheduleEnabled: settings.captureScheduleEnabled,
            },
            "Schedule allows capture; trying to initialize"
          );
          await screenCapture.tryInitialize();
        }
      } while (this.pending);
    } catch (error) {
      logger.error({ error }, "Failed to evaluate capture schedule");
    } finally {
      this.evaluating = false;
    }
  }
}

export const captureScheduleController = new CaptureScheduleController();
