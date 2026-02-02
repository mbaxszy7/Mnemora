import { BrowserWindow, Notification } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-types";
import type {
  NotificationClickPayload,
  NotificationPayload,
  NotificationPreferences,
  NotificationToastPayload,
  NotificationType,
} from "@shared/notification-types";
import { getLogger } from "../logger";
import { mainI18n } from "../i18n-service";
import { timeStringToMinutes } from "@shared/user-settings-utils";
import { userSettingService } from "../user-setting-service";
import { screenshotProcessingEventBus } from "../screenshot-processing/event-bus";
import { screenCaptureEventBus } from "../screen-capture";
import { aiRuntimeEventBus } from "../ai-runtime/event-bus";

const logger = getLogger("notification-service");

function isTimeWithinDnd(now: Date, from: string, to: string): boolean {
  const fromMinutes = timeStringToMinutes(from);
  const toMinutes = timeStringToMinutes(to);
  if (fromMinutes == null || toMinutes == null) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (fromMinutes === toMinutes) return true;

  if (fromMinutes < toMinutes) {
    return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
  }

  return nowMinutes >= fromMinutes || nowMinutes < toMinutes;
}

function shouldShowType(prefs: NotificationPreferences, type: NotificationType): boolean {
  if (!prefs.enabled) return false;
  if (
    prefs.doNotDisturb &&
    isTimeWithinDnd(new Date(), prefs.doNotDisturbFrom, prefs.doNotDisturbTo)
  ) {
    return false;
  }

  switch (type) {
    case "activity-summary":
      return prefs.activitySummary;
    case "llm-broken":
      return prefs.llmErrors;
    case "capture-paused":
      return prefs.capturePaused;
    default:
      return true;
  }
}

export class NotificationService {
  private static instance: NotificationService | null = null;

  private preferences: NotificationPreferences | null = null;
  private readonly lastShownAt = new Map<string, number>();
  private subscriptions: Array<() => void> = [];

  private constructor() {}

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  static resetInstance(): void {
    NotificationService.instance = null;
  }

  private async ensurePreferences(): Promise<NotificationPreferences> {
    if (this.preferences) return this.preferences;
    this.preferences = await userSettingService.getNotificationPreferences();
    return this.preferences;
  }

  async refreshPreferences(): Promise<NotificationPreferences> {
    this.preferences = await userSettingService.getNotificationPreferences();
    return this.preferences;
  }

  async updatePreferences(
    patch: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    const updated = await userSettingService.updateNotificationPreferences(patch);
    this.preferences = updated;
    return updated;
  }

  private mapPriorityToUrgency(
    priority: NotificationPayload["priority"]
  ): "low" | "normal" | "critical" {
    if (priority === "critical") return "critical";
    if (priority === "high") return "normal";
    return "low";
  }

  registerEventBusSubscriptions(): void {
    if (this.subscriptions.length > 0) return;

    this.subscriptions.push(
      screenshotProcessingEventBus.on("activity-summary:succeeded", (event) => {
        void this.show({
          id: `activity-summary:${event.payload.windowStart}`,
          type: "activity-summary",
          priority: "normal",
          title: "notifications.activitySummary.title",
          body: "notifications.activitySummary.body",
          data: {
            windowStart: event.payload.windowStart,
            windowEnd: event.payload.windowEnd,
          },
        });
      })
    );

    this.subscriptions.push(
      aiRuntimeEventBus.on("ai-fuse:tripped", (event) => {
        void this.show({
          id: "ai-fuse-tripped",
          type: "llm-broken",
          priority: "critical",
          title: "notifications.llmBroken.title",
          body: "notifications.llmBroken.body",
          data: {
            count: event.payload.count,
            windowSeconds: Math.round(event.payload.windowMs / 1000),
          },
          toastActions: [
            {
              id: "open-llm-config",
              label: "notifications.actions.openLlmConfig",
            },
          ],
        });
      })
    );

    this.subscriptions.push(
      screenCaptureEventBus.on("capture-scheduler:state", (event) => {
        if (event.currentState !== "paused" || event.previousState === "paused") return;
        void this.show({
          id: `capture-paused:${event.timestamp}`,
          type: "capture-paused",
          priority: "high",
          title: "notifications.capturePaused.title",
          body: "notifications.capturePaused.body",
          data: {
            previous: event.previousState,
          },
        });
      })
    );

    logger.info("NotificationService event bus subscriptions registered");
  }

  dispose(): void {
    for (const unsub of this.subscriptions) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.subscriptions = [];
  }

  private isDuplicate(id: string, windowMs: number): boolean {
    const now = Date.now();
    const last = this.lastShownAt.get(id);
    if (last != null && now - last < windowMs) return true;
    this.lastShownAt.set(id, now);
    return false;
  }

  async show(payload: NotificationPayload): Promise<void> {
    const prefs = await this.ensurePreferences();

    if (!shouldShowType(prefs, payload.type)) {
      logger.debug({ type: payload.type }, "Notification suppressed by preferences");
      return;
    }

    if (payload.priority !== "critical" && this.isDuplicate(payload.id, 30000)) {
      logger.debug({ id: payload.id }, "Duplicate notification suppressed");
      return;
    }

    const silent = payload.silent ?? !prefs.soundEnabled;

    try {
      if (Notification.isSupported()) {
        const title = (mainI18n as unknown as { t: (k: string, o?: unknown) => string }).t(
          payload.title,
          payload.data
        );
        const body = (mainI18n as unknown as { t: (k: string, o?: unknown) => string }).t(
          payload.body,
          payload.data
        );

        const notification = new Notification({
          title,
          body,
          silent,
          urgency: this.mapPriorityToUrgency(payload.priority),
        });

        notification.on("click", () => {
          this.handleNativeNotificationClick(payload);
        });

        notification.show();
      }
    } catch (error) {
      logger.error({ error, payload }, "Failed to show native notification");
    }

    try {
      const toastPayload: NotificationToastPayload = { notification: payload };
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(IPC_CHANNELS.NOTIFICATION_TOAST, toastPayload);
      });
    } catch {
      // ignore
    }
  }

  private handleNativeNotificationClick(payload: NotificationPayload): void {
    try {
      const clickPayload: NotificationClickPayload = {
        notificationId: payload.id,
        notificationType: payload.type,
        data: payload.data,
      };
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(IPC_CHANNELS.NOTIFICATION_ON_CLICK, clickPayload);
      });
    } catch {
      // ignore
    }
  }
}

export const notificationService = NotificationService.getInstance();
