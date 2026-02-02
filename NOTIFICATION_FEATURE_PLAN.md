# Notification Feature Implementation Plan

## Overview

Implement a **unified notification service** for Mnemora that supports:

1. **20-min Activity Summary** - Notify when a new activity window summary is ready
2. **LLM Broken Notification** - Notify when AI/LLM fails (circuit breaker)
3. **Capture Paused Notification** - Notify when capture scheduler enters paused state

**Interaction model (cross-platform):**

- **OS notification**: only guarantees **whole-notification click** (no OS-level action buttons)
- **Action buttons**: provided via **in-app toast** (renderer) for consistent behavior on macOS & Windows

**Decoupling requirement:** `NotificationService` must **not** be imported/used by other services.
It only subscribes to existing **event bus** streams (and we extend event bus types when needed).

**Platform Support:** macOS & Windows with native OS notifications

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RENDERER PROCESS                                │
│  ┌───────────────────────────┐     ┌─────────────────────────────────────┐  │
│  │ useNotification (hooks)   │     │ Notification Settings Component      │  │
│  │ - on OS click → navigate  │     │ - toggle prefs                       │  │
│  │ - on toast payload → toast│     └─────────────────────────────────────┘  │
│  └───────────────┬───────────┘                                             │
│                  │                                                          │
│                  │ IPC: notification:toast, notification:on-click            │
│                  ▼                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                               MAIN PROCESS                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    NotificationService (Singleton)                      │  │
│  │  - subscribes to domain event buses (no direct imports into services)   │  │
│  │  - shows OS notification (click only)                                   │  │
│  │  - broadcasts toast payload to renderer                                 │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │          NativeNotificationAdapter (Electron Notification)       │  │  │
│  │  │          - click → IPC notification:on-click                     │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─────────────────────────────┐     ┌───────────────────────────────────┐  │
│  │ screenshotProcessingEventBus │     │ aiRuntimeEventBus (new)           │  │
│  │ - activity-summary:succeeded │     │ - ai-fuse:tripped                 │  │
│  └─────────────────────────────┘     └───────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
electron/
├── services/
│   └── notification/
│       ├── index.ts                    # Main export
│       ├── notification-service.ts     # Core service
│       ├── notification-adapter.ts     # Cross-platform adapter
│       └── types.ts                    # Notification types
│
├── services/
│   ├── screenshot-processing/
│   │   ├── event-bus.ts                # Existing typed event bus
│   │   └── events.ts                   # Existing event map (contains activity-summary:succeeded)
│   └── ai-runtime/
│       ├── event-bus.ts                # New typed event bus for AI runtime events
│       └── events.ts                   # New event map (ai-fuse:tripped)
├── ipc/
│   └── notification-handlers.ts        # IPC handlers
└── main.ts                             # Initialize service

shared/
├── notification-types.ts               # Shared types & channels
└── ipc-types.ts                        # Add notification channels

shared/locales/
├── en.json                             # Add notification strings
└── zh-CN.json                          # Add notification strings

src/
├── hooks/
│   └── use-notification.ts             # React hook (OS click + in-app toast)
└── components/
    └── settings/
        └── NotificationSettings.tsx    # Settings UI
```

---

## 1. Shared Types

### `shared/notification-types.ts`

```typescript
/**
 * Notification Types
 */
export type NotificationType =
  | "activity-summary" // 20-min activity summary ready
  | "llm-broken" // LLM circuit breaker tripped
  | "capture-paused"; // Screen capture paused notification

/**
 * Notification Priority
 */
export type NotificationPriority = "low" | "normal" | "high" | "critical";

/**
 * Toast Action (in-app only)
 */
export interface NotificationAction {
  id: string;
  label: string; // i18n key
}

/**
 * Base Notification Payload
 */
export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string; // i18n key
  body: string; // i18n key with interpolation
  priority: NotificationPriority;
  toastActions?: NotificationAction[]; // in-app toast actions (OS notifications ignore this)
  data?: Record<string, unknown>; // Additional data for click handling
  silent?: boolean; // No sound
}

/**
 * Activity Summary Notification
 */
export interface ActivitySummaryNotification extends NotificationPayload {
  type: "activity-summary";
  data: {
    windowStart: number;
    windowEnd: number;
    summaryTitle: string;
    appCount: number;
    nodeCount: number;
  };
}

/**
 * LLM Broken Notification
 */
export interface LLMBrokenNotification extends NotificationPayload {
  type: "llm-broken";
  data: {
    failureCount: number;
    timeWindow: number;
    lastError: string;
  };
}

/**
 * User Notification Preferences
 */
export interface NotificationPreferences {
  enabled: boolean;
  activitySummary: boolean; // 20-min summary notifications
  llmErrors: boolean; // LLM broken notifications
  capturePaused: boolean; // Capture paused notifications
  soundEnabled: boolean; // Play sound with notifications
  doNotDisturb: boolean; // Quiet hours
  doNotDisturbFrom: string; // "22:00"
  doNotDisturbTo: string; // "08:00"
}

/**
 * IPC Channel Payloads
 */
export interface ShowNotificationRequest {
  notification: NotificationPayload;
}

export interface NotificationPreferencesRequest {
  preferences: Partial<NotificationPreferences>;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
}

export interface NotificationClickPayload {
  notificationId: string;
  notificationType: NotificationType;
  data?: Record<string, unknown>;
}

export interface NotificationToastPayload {
  notification: NotificationPayload;
}
```

---

## 2. IPC Channels

### Update `shared/ipc-types.ts`

Add to the `IPC_CHANNELS` object:

```typescript
export const IPC_CHANNELS = {
  // ... existing channels

  // Notification channels
  NOTIFICATION_SHOW: "notification:show",
  NOTIFICATION_GET_PREFERENCES: "notification:get-preferences",
  NOTIFICATION_UPDATE_PREFERENCES: "notification:update-preferences",
  NOTIFICATION_ON_CLICK: "notification:on-click",
  NOTIFICATION_TOAST: "notification:toast",
  NOTIFICATION_TEST: "notification:test",
} as const;
```

---

## 3. Localization Strings

### `shared/locales/en.json`

Add to the JSON:

```json
{
  "notifications": {
    "activitySummary": {
      "title": "Activity Summary Ready",
      "body": "Your activity from {{timeRange}}: {{summary}}",
      "actionView": "View Details"
    },
    "llmBroken": {
      "title": "AI Service Issue",
      "body": "{{count}} failures detected. Screen capture has been paused.",
      "actionCheckConfig": "Check Configuration",
      "actionDismiss": "Dismiss"
    },
    "capturePaused": {
      "title": "Capture Paused",
      "body": "Screen capture has been paused automatically."
    },
    "settings": {
      "title": "Notifications",
      "description": "Configure how and when you receive notifications",
      "enable": {
        "label": "Enable Notifications",
        "description": "Show system notifications for activities and alerts"
      },
      "activitySummary": {
        "label": "Activity Summaries",
        "description": "Notify when 20-minute activity summaries are ready"
      },
      "llmErrors": {
        "label": "AI Error Alerts",
        "description": "Notify when AI service encounters issues"
      },
      "capturePaused": {
        "label": "Capture Paused",
        "description": "Notify when screen capture is paused"
      },
      "sound": {
        "label": "Notification Sound",
        "description": "Play sound with notifications"
      },
      "doNotDisturb": {
        "label": "Do Not Disturb",
        "description": "Silence notifications during specified hours",
        "from": "From",
        "to": "To"
      }
    }
  }
}
```

---

## 4. Notification Service

### `electron/services/notification/notification-service.ts`

```typescript
import { Notification, BrowserWindow, app } from "electron";
import path from "node:path";
import { getLogger } from "../logger";
import { mainI18n } from "../i18n-service";
import { screenshotProcessingEventBus } from "../screenshot-processing/event-bus";
import { screenCaptureEventBus } from "../screen-capture/event-bus";
import { aiRuntimeEventBus } from "../ai-runtime/event-bus";
import {
  NotificationPayload,
  NotificationType,
  NotificationPreferences,
  NotificationClickPayload,
  NotificationToastPayload,
} from "@shared/notification-types";
import { IPC_CHANNELS } from "@shared/ipc-types";

const logger = getLogger("notification-service");

/**
 * Platform-specific notification adapter interface
 */
interface INotificationAdapter {
  show(payload: NotificationPayload): void;
  isSupported(): boolean;
  requestPermission?(): Promise<boolean>;
}

/**
 * Native notification adapter using Electron's Notification API
 */
class NativeNotificationAdapter implements INotificationAdapter {
  private iconPath: string;

  constructor() {
    const iconBase = app.isPackaged
      ? process.resourcesPath
      : path.join(process.env.APP_ROOT || "", "public");
    this.iconPath = path.join(iconBase, "logo.png");
  }

  isSupported(): boolean {
    return Notification.isSupported();
  }

  show(payload: NotificationPayload): void {
    if (!this.isSupported()) {
      logger.warn("Native notifications not supported on this platform");
      return;
    }

    const notification = new Notification({
      title: mainI18n.t(payload.title),
      body: this.interpolateBody(payload.body, payload.data),
      icon: this.iconPath,
      silent: payload.silent ?? false,
      urgency: this.mapPriorityToUrgency(payload.priority),
    });

    notification.on("click", () => {
      this.handleNotificationClick(payload);
    });

    notification.show();
  }

  private interpolateBody(bodyTemplate: string, data?: Record<string, unknown>): string {
    if (!data) return mainI18n.t(bodyTemplate);

    let result = mainI18n.t(bodyTemplate);
    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`{{${key}}}`, "g"), String(value));
    }
    return result;
  }

  private mapPriorityToUrgency(priority: string): "normal" | "critical" | "low" {
    switch (priority) {
      case "critical":
      case "high":
        return "critical";
      case "low":
        return "low";
      default:
        return "normal";
    }
  }

  private handleNotificationClick(payload: NotificationPayload): void {
    // Focus main window
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }

    // Send IPC to renderer
    const clickPayload: NotificationClickPayload = {
      notificationId: payload.id,
      notificationType: payload.type,
      data: payload.data,
    };

    // Broadcast to all renderer processes
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_CHANNELS.NOTIFICATION_ON_CLICK, clickPayload);
    });

    logger.info({ clickPayload }, "Notification clicked");
  }
}

/**
 * Main Notification Service - Singleton
 */
export class NotificationService {
  private static instance: NotificationService | null = null;
  private adapter: INotificationAdapter;
  private preferences: NotificationPreferences;
  private logger = getLogger("notification-service");
  private notificationHistory: Map<string, number> = new Map(); // Deduplication

  private constructor() {
    this.adapter = new NativeNotificationAdapter();
    this.preferences = this.getDefaultPreferences();
  }

  /**
   * Subscribe to domain event buses (decoupled, no imports into other services)
   */
  registerEventBusSubscriptions(): void {
    screenshotProcessingEventBus.on("activity-summary:succeeded", (event) => {
      this.show({
        id: `activity-${event.payload.windowStart}`,
        type: "activity-summary",
        title: "notifications.activitySummary.title",
        body: "notifications.activitySummary.body",
        priority: "normal",
        data: {
          windowStart: event.payload.windowStart,
          windowEnd: event.payload.windowEnd,
        },
        toastActions: [{ id: "view", label: "notifications.activitySummary.actionView" }],
      });
    });

    screenCaptureEventBus.on("capture-scheduler:state", (event) => {
      if (event.currentState !== "paused") return;
      this.show({
        id: `capture-paused-${event.timestamp}`,
        type: "capture-paused",
        title: "notifications.capturePaused.title",
        body: "notifications.capturePaused.body",
        priority: "high",
      });
    });

    aiRuntimeEventBus.on("ai-fuse:tripped", (event) => {
      this.show({
        id: `llm-broken-${event.timestamp}`,
        type: "llm-broken",
        title: "notifications.llmBroken.title",
        body: "notifications.llmBroken.body",
        priority: "critical",
        data: {
          count: event.payload.count,
          timeWindow: event.payload.windowMs,
          lastError: event.payload.lastError,
        },
        toastActions: [
          { id: "check-config", label: "notifications.llmBroken.actionCheckConfig" },
          { id: "dismiss", label: "notifications.llmBroken.actionDismiss" },
        ],
      });
    });
  }

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  static resetInstance(): void {
    NotificationService.instance = null;
  }

  /**
   * Initialize service with user preferences
   */
  initialize(preferences?: NotificationPreferences): void {
    if (preferences) {
      this.preferences = { ...this.preferences, ...preferences };
    }

    this.logger.info(
      {
        enabled: this.preferences.enabled,
        adapter: this.adapter.constructor.name,
      },
      "Notification service initialized"
    );
  }

  /**
   * Get default preferences
   */
  private getDefaultPreferences(): NotificationPreferences {
    return {
      enabled: true,
      activitySummary: true,
      llmErrors: true,
      capturePaused: true,
      soundEnabled: true,
      doNotDisturb: false,
      doNotDisturbFrom: "22:00",
      doNotDisturbTo: "08:00",
    };
  }

  /**
   * Check if currently in do-not-disturb hours
   */
  private isInDoNotDisturb(): boolean {
    if (!this.preferences.doNotDisturb) return false;

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const { doNotDisturbFrom, doNotDisturbTo } = this.preferences;

    if (doNotDisturbFrom <= doNotDisturbTo) {
      // Same day range (e.g., 09:00 - 17:00)
      return currentTime >= doNotDisturbFrom && currentTime <= doNotDisturbTo;
    } else {
      // Overnight range (e.g., 22:00 - 08:00)
      return currentTime >= doNotDisturbFrom || currentTime <= doNotDisturbTo;
    }
  }

  /**
   * Check if notification should be shown based on preferences
   */
  private shouldShow(type: NotificationType, priority: string): boolean {
    // Always show critical notifications
    if (priority === "critical") return true;

    // Check master switch
    if (!this.preferences.enabled) return false;

    // Check do not disturb
    if (this.isInDoNotDisturb()) return false;

    // Check type-specific settings
    switch (type) {
      case "activity-summary":
        return this.preferences.activitySummary;
      case "llm-broken":
        return this.preferences.llmErrors;
      default:
        return true;
    }
  }

  /**
   * Check for duplicate notifications (rate limiting)
   */
  private isDuplicate(id: string, windowMs: number = 60000): boolean {
    const now = Date.now();
    const lastShown = this.notificationHistory.get(id);

    if (lastShown && now - lastShown < windowMs) {
      return true;
    }

    this.notificationHistory.set(id, now);

    // Cleanup old entries
    for (const [key, timestamp] of this.notificationHistory.entries()) {
      if (now - timestamp > windowMs * 2) {
        this.notificationHistory.delete(key);
      }
    }

    return false;
  }

  /**
   * Show a notification
   */
  show(payload: NotificationPayload): void {
    // Check if should show
    if (!this.shouldShow(payload.type, payload.priority)) {
      this.logger.debug({ type: payload.type }, "Notification suppressed by preferences");
      return;
    }

    // Check for duplicates (except critical)
    if (payload.priority !== "critical" && this.isDuplicate(payload.id, 30000)) {
      this.logger.debug({ id: payload.id }, "Duplicate notification suppressed");
      return;
    }

    // Apply sound preference
    const finalPayload: NotificationPayload = {
      ...payload,
      silent: payload.silent ?? !this.preferences.soundEnabled,
    };

    // Show via adapter
    try {
      this.adapter.show(finalPayload);
      this.logger.info({ type: payload.type, id: payload.id }, "Notification shown");
    } catch (error) {
      this.logger.error({ error, payload }, "Failed to show notification");
    }

    // Broadcast toast payload to renderer (for action buttons)
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(IPC_CHANNELS.NOTIFICATION_TOAST, {
          notification: finalPayload,
        } satisfies NotificationToastPayload);
      });
    } catch {
      // ignore when running in tests
    }
  }

  /**
   * Update user preferences
   */
  updatePreferences(preferences: Partial<NotificationPreferences>): void {
    this.preferences = { ...this.preferences, ...preferences };
    this.logger.info({ preferences: this.preferences }, "Preferences updated");
  }

  /**
   * Get current preferences
   */
  getPreferences(): NotificationPreferences {
    return { ...this.preferences };
  }

  /**
   * Convenience method: Activity Summary Notification
   */
  showActivitySummary(
    windowStart: number,
    windowEnd: number,
    summaryTitle: string,
    stats: {
      appCount: number;
      nodeCount: number;
    }
  ): void {
    const timeRange = this.formatTimeRange(windowStart, windowEnd);

    this.show({
      id: `activity-${windowStart}`,
      type: "activity-summary",
      title: "notifications.activitySummary.title",
      body: "notifications.activitySummary.body",
      priority: "normal",
      data: {
        timeRange,
        summary: summaryTitle,
        windowStart,
        windowEnd,
        ...stats,
      },
      toastActions: [{ id: "view", label: "notifications.activitySummary.actionView" }],
    });
  }

  /**
   * Convenience method: LLM Broken Notification
   */
  showLLMBroken(failureCount: number, timeWindow: number, lastError: string): void {
    this.show({
      id: `llm-broken-${Date.now()}`,
      type: "llm-broken",
      title: "notifications.llmBroken.title",
      body: "notifications.llmBroken.body",
      priority: "critical",
      data: {
        count: failureCount,
        timeWindow,
        lastError,
      },
      toastActions: [
        { id: "check-config", label: "notifications.llmBroken.actionCheckConfig" },
        { id: "dismiss", label: "notifications.llmBroken.actionDismiss" },
      ],
    });
  }

  /**
   * Format time range for display
   */
  private formatTimeRange(start: number, end: number): string {
    const startDate = new Date(start);
    const endDate = new Date(end);
    return `${startDate.getHours()}:${String(startDate.getMinutes()).padStart(2, "0")} - ${endDate.getHours()}:${String(endDate.getMinutes()).padStart(2, "0")}`;
  }
}

// Export singleton instance
export const notificationService = NotificationService.getInstance();
```

---

## 5. Integration with Existing Services

### 5.1 Activity Monitor Integration

**No direct integration needed.**

This codebase already emits a typed event when an activity window summary succeeds:

- `electron/services/screenshot-processing/event-bus.ts`
- `electron/services/screenshot-processing/events.ts` contains `"activity-summary:succeeded"`
- `electron/services/screenshot-processing/activity-monitor-service.ts` already calls:
  `screenshotProcessingEventBus.emit("activity-summary:succeeded", ...)`

`NotificationService` subscribes to this event bus and decides whether to show a notification.

### 5.2 LLM Circuit Breaker Integration

Do **not** call `notificationService` from AI services.

Instead, introduce a typed AI runtime event bus (same style as existing screen-capture/screenshot-processing buses):

- `electron/services/ai-runtime/events.ts`
- `electron/services/ai-runtime/event-bus.ts`

When the fuse trips inside `electron/services/ai-runtime-service.ts`, emit:

- `ai-fuse:tripped` (payload includes `count`, `windowMs`, and optional `lastError`)

`NotificationService` subscribes to `aiRuntimeEventBus` and shows OS notification + in-app toast.

---

## 6. IPC Handlers

### `electron/ipc/notification-handlers.ts`

```typescript
import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { notificationService } from "../services/notification/notification-service";
import type {
  ShowNotificationRequest,
  NotificationPreferencesRequest,
  NotificationPreferencesResponse,
} from "@shared/notification-types";
import { getLogger } from "../services/logger";

const logger = getLogger("notification-handlers");

async function handleShowNotification(
  _event: IpcMainInvokeEvent,
  request: ShowNotificationRequest
): Promise<IPCResult<void>> {
  try {
    notificationService.show(request.notification);
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Failed to show notification");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleGetPreferences(): Promise<IPCResult<NotificationPreferencesResponse>> {
  try {
    return {
      success: true,
      data: { preferences: notificationService.getPreferences() },
    };
  } catch (error) {
    logger.error({ error }, "Failed to get notification preferences");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleUpdatePreferences(
  _event: IpcMainInvokeEvent,
  request: NotificationPreferencesRequest
): Promise<IPCResult<NotificationPreferencesResponse>> {
  try {
    notificationService.updatePreferences(request.preferences);
    return {
      success: true,
      data: { preferences: notificationService.getPreferences() },
    };
  } catch (error) {
    logger.error({ error }, "Failed to update notification preferences");
    return { success: false, error: toIPCError(error) };
  }
}

export function registerNotificationHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  registry.registerHandler(IPC_CHANNELS.NOTIFICATION_SHOW, handleShowNotification);
  registry.registerHandler(IPC_CHANNELS.NOTIFICATION_GET_PREFERENCES, handleGetPreferences);
  registry.registerHandler(IPC_CHANNELS.NOTIFICATION_UPDATE_PREFERENCES, handleUpdatePreferences);
}
```

---

## 7. Preload Script Update

### `electron/preload.ts`

Add to the preload file:

```typescript
// --------- Expose Notification API to the Renderer process ---------
export interface NotificationApi {
  show(request: ShowNotificationRequest): Promise<IPCResult<void>>;
  getPreferences(): Promise<IPCResult<NotificationPreferencesResponse>>;
  updatePreferences(
    preferences: Partial<NotificationPreferences>
  ): Promise<IPCResult<NotificationPreferencesResponse>>;
  onNotificationClick(callback: (payload: NotificationClickPayload) => void): () => void;
  onNotificationToast(callback: (payload: NotificationToastPayload) => void): () => void;
}

const notificationApi: NotificationApi = {
  async show(request: ShowNotificationRequest): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_SHOW, request);
  },

  async getPreferences(): Promise<IPCResult<NotificationPreferencesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_GET_PREFERENCES);
  },

  async updatePreferences(
    preferences: Partial<NotificationPreferences>
  ): Promise<IPCResult<NotificationPreferencesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_UPDATE_PREFERENCES, { preferences });
  },

  onNotificationClick(callback: (payload: NotificationClickPayload) => void) {
    const subscription = (_event: unknown, payload: NotificationClickPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_ON_CLICK, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_ON_CLICK, subscription);
    };
  },

  onNotificationToast(callback: (payload: NotificationToastPayload) => void) {
    const subscription = (_event: unknown, payload: NotificationToastPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_TOAST, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_TOAST, subscription);
    };
  },
};

contextBridge.exposeInMainWorld("notificationApi", notificationApi);
```

---

## 8. React Hook

### `src/hooks/use-notification.ts`

```typescript
import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type {
  NotificationClickPayload,
  NotificationToastPayload,
} from "@shared/notification-types";
import { toast } from "sonner";

export function useNotification(): void {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleNotificationClick = useCallback(
    (payload: NotificationClickPayload) => {
      switch (payload.notificationType) {
        case "activity-summary":
          // Navigate to activity page with specific window
          if (payload.data?.windowStart) {
            navigate(`/?window=${payload.data.windowStart}`);
          } else {
            navigate("/");
          }
          break;

        case "llm-broken":
          // OS notification is click-only, so we use a default navigation target
          navigate("/settings/llm-config");
          break;

        default:
          // Show toast for unhandled notifications
          toast.info("Notification clicked", {
            description: payload.notificationType,
          });
      }
    },
    [navigate]
  );

  const handleNotificationToast = useCallback(
    (payload: NotificationToastPayload) => {
      const n = payload.notification;

      const title = t(n.title, n.data);
      const description = t(n.body, n.data);

      // In-app toast provides action buttons (cross-platform)
      if (n.type === "llm-broken") {
        const primary = n.toastActions?.find((a) => a.id === "check-config") ?? n.toastActions?.[0];
        toast.error(title, {
          description,
          action: primary
            ? {
                label: t(primary.label),
                onClick: () => navigate("/settings/llm-config"),
              }
            : undefined,
        });
        return;
      }

      toast.info(title, {
        description,
      });
    },
    [navigate, t]
  );

  useEffect(() => {
    const unsubscribe = window.notificationApi.onNotificationClick(handleNotificationClick);
    return () => unsubscribe();
  }, [handleNotificationClick]);

  useEffect(() => {
    const unsubscribe = window.notificationApi.onNotificationToast(handleNotificationToast);
    return () => unsubscribe();
  }, [handleNotificationToast]);
}
```

---

## 9. Settings UI Component

```tsx
import { useState, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import type { NotificationPreferences } from "@shared/notification-types";

export function NotificationSettings(): JSX.Element {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPreferences();
  }, []);

  const loadPreferences = async () => {
    const result = await window.notificationApi.getPreferences();
    if (result.success && result.data) {
      setPreferences(result.data.preferences);
    }
    setLoading(false);
  };

  const updatePreference = async <K extends keyof NotificationPreferences>(
    key: K,
    value: NotificationPreferences[K]
  ) => {
    if (!preferences) return;

    const newPrefs = { ...preferences, [key]: value };
    setPreferences(newPrefs);

    await window.notificationApi.updatePreferences({ [key]: value });
  };

  if (loading || !preferences) {
    return <div>Loading...</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("notifications.settings.title")}</CardTitle>
        <CardDescription>{t("notifications.settings.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Master Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("notifications.settings.enable.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.settings.enable.description")}
            </p>
          </div>
          <Switch
            checked={preferences.enabled}
            onCheckedChange={(v) => updatePreference("enabled", v)}
          />
        </div>

        {/* Activity Summary */}
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("notifications.settings.activitySummary.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.settings.activitySummary.description")}
            </p>
          </div>
          <Switch
            checked={preferences.activitySummary}
            onCheckedChange={(v) => updatePreference("activitySummary", v)}
            disabled={!preferences.enabled}
          />
        </div>

        {/* LLM Errors */}
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("notifications.settings.llmErrors.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.settings.llmErrors.description")}
            </p>
          </div>
          <Switch
            checked={preferences.llmErrors}
            onCheckedChange={(v) => updatePreference("llmErrors", v)}
            disabled={!preferences.enabled}
          />
        </div>

        {/* Capture Paused */}
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("notifications.settings.capturePaused.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.settings.capturePaused.description")}
            </p>
          </div>
          <Switch
            checked={preferences.capturePaused}
            onCheckedChange={(v) => updatePreference("capturePaused", v)}
            disabled={!preferences.enabled}
          />
        </div>

        {/* Sound */}
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("notifications.settings.sound.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.settings.sound.description")}
            </p>
          </div>
          <Switch
            checked={preferences.soundEnabled}
            onCheckedChange={(v) => updatePreference("soundEnabled", v)}
            disabled={!preferences.enabled}
          />
        </div>
      </CardContent>
    </Card>
  );
}
```

---

## 10. Initialization

### `electron/main.ts`

```typescript
// Add import
import { notificationService } from "./services/notification/notification-service";
import { registerNotificationHandlers } from "./ipc/notification-handlers";

// In initializeApp():
private async initializeApp(): Promise<void> {
  // ... existing code ...

  // Register notification handlers
  registerNotificationHandlers();

  // Initialize notification service
  notificationService.initialize();
  notificationService.registerEventBusSubscriptions();

  // ... rest of initialization ...
}
```

---

## Implementation Checklist

| #   | Task                                                         | Files                                                               |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | Create shared notification types                             | `shared/notification-types.ts`                                      |
| 2   | Add IPC channels                                             | `shared/ipc-types.ts`                                               |
| 3   | Add localization strings                                     | `shared/locales/en.json`, `zh-CN.json`                              |
| 4   | Create notification service                                  | `electron/services/notification/*.ts`                               |
| 5   | Create IPC handlers                                          | `electron/ipc/notification-handlers.ts`                             |
| 6   | Update preload script                                        | `electron/preload.ts`                                               |
| 7   | Update main.ts initialization                                | `electron/main.ts`                                                  |
| 8   | Create React hook                                            | `src/hooks/use-notification.ts`                                     |
| 9   | Create settings UI                                           | `src/components/settings/NotificationSettings.tsx`                  |
| 10  | Wire notifications to screenshot-processing event bus        | `electron/services/screenshot-processing/event-bus.ts`, `events.ts` |
| 11  | Wire capture paused notification to screen-capture event bus | `electron/services/screen-capture/event-bus.ts`, `events.ts`        |
| 12  | Add type declarations                                        | `electron/electron-env.d.ts`                                        |
| 13  | Add AI runtime event bus                                     | `electron/services/ai-runtime/event-bus.ts`, `events.ts`            |

---

## Platform-Specific Notes

### macOS

- Uses `NotificationCenter` with automatic grouping by app
- OS notification interactions are **click-only** in this design (actions are in-app toast)
- Requires `com.apple.security.network.client` entitlement if fetching images
- Badge count can be set via `app.dock.setBadge()`

### Windows

- Uses Windows 10/11 native toast notifications
- Requires app to be registered with `app.setAppUserModelId()` (already done in main.ts)
- OS notification interactions are **click-only** in this design (actions are in-app toast)
- Notifications persist in Action Center

---

## Features Summary

| Feature          | Description                                    | Priority |
| ---------------- | ---------------------------------------------- | -------- |
| Activity Summary | Notify when 20-min window summary is generated | Normal   |
| LLM Broken       | Notify when AI service fails (circuit breaker) | Critical |
| Capture Paused   | Notify when capture scheduler is paused        | High     |
| Preferences      | Enable/disable notifications per type          | -        |
| Do Not Disturb   | Quiet hours configuration                      | -        |
| Sound Control    | Toggle notification sounds                     | -        |
| Actions          | In-app toast actions (cross-platform)          | -        |
| Rate Limiting    | Prevent duplicate notifications                | -        |
