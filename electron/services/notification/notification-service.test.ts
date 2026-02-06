import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-types";

const mockSend = vi.hoisted(() => vi.fn());
const mockWindows = vi.hoisted(() => [
  {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: mockSend },
  },
]);

const mockNotificationOn = vi.hoisted(() => vi.fn());
const mockNotificationShow = vi.hoisted(() => vi.fn());
const mockNotificationIsSupported = vi.hoisted(() => vi.fn(() => true));

const mockGetPrefs = vi.hoisted(() =>
  vi.fn(async () => ({
    enabled: true,
    activitySummary: true,
    llmErrors: true,
    capturePaused: true,
    soundEnabled: true,
    doNotDisturb: false,
    doNotDisturbFrom: "22:00",
    doNotDisturbTo: "08:00",
  }))
);
const mockUpdatePrefs = vi.hoisted(() => vi.fn());
const mockEventOn = vi.hoisted(() => vi.fn(() => vi.fn()));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => "C:/app"),
    focus: vi.fn(),
    emit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => mockWindows),
    getFocusedWindow: vi.fn(() => null),
  },
  Notification: class {
    static isSupported = mockNotificationIsSupported;
    on = mockNotificationOn;
    show = mockNotificationShow;
    constructor() {}
  },
}));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../i18n-service", () => ({ mainI18n: { t: vi.fn((k: string) => k) } }));
vi.mock("../user-setting-service", () => ({
  userSettingService: {
    getNotificationPreferences: mockGetPrefs,
    updateNotificationPreferences: mockUpdatePrefs,
  },
}));
vi.mock("../screenshot-processing/event-bus", () => ({
  screenshotProcessingEventBus: { on: mockEventOn },
}));
vi.mock("../screen-capture", () => ({ screenCaptureEventBus: { on: mockEventOn } }));
vi.mock("../ai-runtime/event-bus", () => ({ aiRuntimeEventBus: { on: mockEventOn } }));

import { NotificationService } from "./notification-service";

describe("NotificationService", () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    NotificationService.resetInstance();
    service = NotificationService.getInstance();
  });

  it("registers event bus subscriptions idempotently", () => {
    service.registerEventBusSubscriptions();
    service.registerEventBusSubscriptions();
    expect(mockEventOn).toHaveBeenCalledTimes(3);
  });

  it("suppresses notification by preferences", async () => {
    mockGetPrefs.mockResolvedValueOnce({
      enabled: false,
      activitySummary: false,
      llmErrors: false,
      capturePaused: false,
      soundEnabled: false,
      doNotDisturb: false,
      doNotDisturbFrom: "22:00",
      doNotDisturbTo: "08:00",
    });

    await service.show({
      id: "n1",
      type: "activity-summary",
      priority: "normal",
      title: "title",
      body: "body",
    });

    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it("shows native notification and sends renderer toast", async () => {
    await service.show({
      id: "n2",
      type: "activity-summary",
      priority: "normal",
      title: "title",
      body: "body",
    });

    expect(mockNotificationShow).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_TOAST,
      expect.objectContaining({
        notification: expect.objectContaining({ id: "n2" }),
      })
    );
  });

  it("suppresses duplicate non-critical notifications", async () => {
    await service.show({
      id: "dup",
      type: "activity-summary",
      priority: "normal",
      title: "title",
      body: "body",
    });
    await service.show({
      id: "dup",
      type: "activity-summary",
      priority: "normal",
      title: "title",
      body: "body",
    });

    expect(mockNotificationShow).toHaveBeenCalledTimes(1);
  });
});
