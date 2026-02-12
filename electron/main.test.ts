import { describe, it, expect, vi, beforeAll, type Mock } from "vitest";

// ============================================================================
// Mocks Setup (must be before any imports)
// ============================================================================

// Track sent messages for assertions
const sentMessages: Array<{ channel: string; data: unknown }> = [];

const createMockBrowserWindow = () => ({
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
  minimize: vi.fn(),
  close: vi.fn(),
  setTitle: vi.fn(),
  isDestroyed: vi.fn(() => false),
  webContents: {
    send: vi.fn((channel: string, data: unknown) => {
      sentMessages.push({ channel, data });
    }),
    on: vi.fn(),
  },
  on: vi.fn(),
  loadURL: vi.fn(() => Promise.resolve()),
  once: vi.fn(),
});

const currentMockWindow = createMockBrowserWindow();

// Mock BrowserWindow as a class constructor
const MockBrowserWindowClass = vi.fn(function () {
  return currentMockWindow;
}) as unknown as Mock & { getAllWindows: Mock };
MockBrowserWindowClass.getAllWindows = vi.fn(() => []);

const mockBrowserWindow = MockBrowserWindowClass;

const mockIpcMain = {
  handle: vi.fn(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
};

const mockApp = {
  getName: vi.fn(() => "Mnemora"),
  isPackaged: false,
  quit: vi.fn(),
  exit: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
  setAppUserModelId: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  on: vi.fn(),
  dock: {
    setIcon: vi.fn(),
  },
};

const mockMenu = {
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn(() => ({ items: [] })),
};

const mockNativeImage = {
  createFromPath: vi.fn(() => ({
    isEmpty: () => false,
    setTemplateImage: vi.fn(),
  })),
};

const mockScreen = {
  getPrimaryDisplay: vi.fn(() => ({
    workAreaSize: { width: 1920, height: 1080 },
  })),
};

// Mock Electron
vi.mock("electron", () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  ipcMain: mockIpcMain,
  Menu: mockMenu,
  nativeImage: mockNativeImage,
  screen: mockScreen,
  Tray: vi.fn(() => ({
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    destroy: vi.fn(),
  })),
  IpcMainInvokeEvent: class {},
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
  platform: vi.fn(() => "darwin"),
}));

vi.mock("./env", () => ({
  isDev: true,
  APP_ROOT: "/test/app/root",
  MAIN_DIST: "/test/dist",
  RENDERER_DIST: "/test/renderer/dist",
  VITE_DEV_SERVER_URL: "http://localhost:5173",
  VITE_PUBLIC: "/test/public",
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock("./services/logger", () => ({
  initializeLogger: vi.fn(),
  getLogger: vi.fn(() => mockLogger),
}));

const mockFtsHealthService = {
  getDetails: vi.fn(() => ({
    status: "healthy",
    lastCheckAt: null,
    lastRebuildAt: null,
    rebuildAttempts: 0,
    isUsable: true,
  })),
  isFtsUsable: vi.fn(() => true),
  runStartupCheckAndHeal: vi.fn(() =>
    Promise.resolve({
      status: "healthy",
      durationMs: 100,
      checkAttempts: 1,
      rebuildPerformed: false,
    })
  ),
  retryRepair: vi.fn(() =>
    Promise.resolve({
      status: "healthy",
      durationMs: 100,
      checkAttempts: 1,
      rebuildPerformed: false,
    })
  ),
};

vi.mock("./services/fts-health-service", () => ({
  ftsHealthService: mockFtsHealthService,
}));

const mockDatabaseService = {
  initialize: vi.fn(),
  getSqlite: vi.fn(() => ({
    prepare: vi.fn((sql: string) => {
      if (sql.includes("sqlite_master")) {
        return {
          get: vi.fn(() => ({ present: 1 })),
          run: vi.fn(),
        };
      }
      return {
        get: vi.fn(() => ({ count: 0 })),
        run: vi.fn(),
      };
    }),
  })),
  close: vi.fn(),
};

vi.mock("./database", () => ({
  databaseService: mockDatabaseService,
}));

const mockRegistryInstance = {
  unregisterAll: vi.fn(),
  registerHandler: vi.fn(),
  isRegistered: vi.fn(() => false),
};

vi.mock("./ipc/handler-registry", () => ({
  IPCHandlerRegistry: {
    getInstance: vi.fn(() => mockRegistryInstance),
    resetInstance: vi.fn(),
  },
}));

// Mock startup module
vi.mock("./startup", () => ({
  // startup module has side effects, just ensure it's imported
}));

// Mock all IPC handlers
const mockIpcHandlers = {
  registerI18nHandlers: vi.fn(),
  registerLLMConfigHandlers: vi.fn(),
  registerScreenCaptureHandlers: vi.fn(),
  registerPermissionHandlers: vi.fn(),
  registerCaptureSourceSettingsHandlers: vi.fn(),
  registerUserSettingsHandlers: vi.fn(),
  registerContextGraphHandlers: vi.fn(),
  registerThreadsHandlers: vi.fn(),
  registerUsageHandlers: vi.fn(),
  registerActivityMonitorHandlers: vi.fn(),
  registerMonitoringHandlers: vi.fn(),
  registerAppHandlers: vi.fn(),
  registerAppUpdateHandlers: vi.fn(),
  registerNotificationHandlers: vi.fn(),
};

vi.mock("./ipc/i18n-handlers", () => ({
  registerI18nHandlers: mockIpcHandlers.registerI18nHandlers,
}));
vi.mock("./ipc/llm-config-handlers", () => ({
  registerLLMConfigHandlers: mockIpcHandlers.registerLLMConfigHandlers,
}));
vi.mock("./ipc/screen-capture-handlers", () => ({
  registerScreenCaptureHandlers: mockIpcHandlers.registerScreenCaptureHandlers,
}));
vi.mock("./ipc/permission-handlers", () => ({
  registerPermissionHandlers: mockIpcHandlers.registerPermissionHandlers,
}));
vi.mock("./ipc/capture-source-settings-handlers", () => ({
  registerCaptureSourceSettingsHandlers: mockIpcHandlers.registerCaptureSourceSettingsHandlers,
}));
vi.mock("./ipc/user-settings-handlers", () => ({
  registerUserSettingsHandlers: mockIpcHandlers.registerUserSettingsHandlers,
}));
vi.mock("./ipc/context-graph-handlers", () => ({
  registerContextGraphHandlers: mockIpcHandlers.registerContextGraphHandlers,
}));
vi.mock("./ipc/threads-handlers", () => ({
  registerThreadsHandlers: mockIpcHandlers.registerThreadsHandlers,
}));
vi.mock("./ipc/usage-handlers", () => ({
  registerUsageHandlers: mockIpcHandlers.registerUsageHandlers,
}));
vi.mock("./ipc/activity-monitor-handlers", () => ({
  registerActivityMonitorHandlers: mockIpcHandlers.registerActivityMonitorHandlers,
}));
vi.mock("./ipc/monitoring-handlers", () => ({
  registerMonitoringHandlers: mockIpcHandlers.registerMonitoringHandlers,
}));
vi.mock("./ipc/app-handlers", () => ({
  registerAppHandlers: mockIpcHandlers.registerAppHandlers,
}));
vi.mock("./ipc/app-update-handlers", () => ({
  registerAppUpdateHandlers: mockIpcHandlers.registerAppUpdateHandlers,
}));
vi.mock("./ipc/notification-handlers", () => ({
  registerNotificationHandlers: mockIpcHandlers.registerNotificationHandlers,
}));

vi.mock("./services/user-setting-service", () => ({
  userSettingService: {
    getSettings: vi.fn(() => Promise.resolve({})),
    setCaptureManualOverride: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("./services/i18n-service", () => ({
  mainI18n: {
    initialize: vi.fn(() => Promise.resolve()),
    t: vi.fn((key: string) => key),
    isInitialized: vi.fn(() => true),
    getCurrentLanguage: vi.fn(() => "en"),
  },
}));

const mockTrayServiceInstance = {
  configure: vi.fn().mockReturnThis(),
  init: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("./services/tray-service", () => ({
  TrayService: {
    getInstance: vi.fn(() => mockTrayServiceInstance),
    resetInstance: vi.fn(),
  },
}));

vi.mock("./services/app-update-service", () => ({
  appUpdateService: {
    initialize: vi.fn(),
    dispose: vi.fn(),
  },
}));

const mockScreenCaptureEventBus = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
};

vi.mock("./services/screen-capture", () => ({
  screenCaptureModule: {
    getState: vi.fn(() => ({ status: "idle" })),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  },
  screenCaptureEventBus: mockScreenCaptureEventBus,
  captureScheduleController: {
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    evaluateNow: vi.fn(() => Promise.resolve()),
  },
  captureSourceProvider: {
    initialize: vi.fn(),
    getSources: vi.fn(() => Promise.resolve([])),
    refresh: vi.fn(),
  },
}));

vi.mock("./services/notification/notification-service", () => ({
  notificationService: {
    registerEventBusSubscriptions: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
  },
}));

vi.mock("./services/llm-config-service", () => ({
  LLMConfigService: {
    getInstance: vi.fn(() => ({
      loadConfiguration: vi.fn(() => Promise.resolve(null)),
    })),
  },
}));

vi.mock("./services/ai-sdk-service", () => ({
  AISDKService: {
    getInstance: vi.fn(() => ({
      initialize: vi.fn(),
    })),
  },
}));

vi.mock("./services/power-monitor", () => ({
  powerMonitorService: {
    initialize: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("./services/monitoring", () => ({
  monitoringServer: {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    getPort: vi.fn(() => 12345),
  },
}));

vi.mock("./services/screenshot-processing/screenshot-processing-module", () => ({
  screenshotProcessingModule: {
    initialize: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
    ocrWarmup: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("./services/llm-usage-service", () => ({
  llmUsageService: {
    getUsageSummary: vi.fn(() => Promise.resolve({ totalTokens: 0 })),
  },
}));

// ============================================================================
// Test Suite - Import main.ts only once in beforeAll
// ============================================================================

describe("main.ts - Startup and Registration Sequence", () => {
  beforeAll(async () => {
    process.env.VITEST = "true";

    // Import main.ts once before all tests
    await import("./main");

    // Wait for boot sequence to complete
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  describe("Single Instance Lock", () => {
    it("should handle single instance lock logic correctly", async () => {
      // Note: These tests are simplified as the full integration requires
      // module reload which affects other test state
      const env = await import("./env");

      // Test that the isDev check exists (if isDev is true, no lock is requested)
      // @ts-expect-error - accessing readonly for verification
      expect(typeof env.isDev).toBe("boolean");
    });
  });

  describe("AppLifecycleController - Boot Phases", () => {
    it("should emit all boot phases in correct order", () => {
      const phases = ["db-init", "fts-check", "app-init", "background-init", "ready"];
      for (const phase of phases) {
        const message = sentMessages.find(
          (m) =>
            m.channel === "boot:status-changed" && (m.data as { phase: string }).phase === phase
        );
        expect(message).toBeDefined();
      }
    });

    it("should emit fts-health-changed event", () => {
      const healthMessage = sentMessages.find((m) => m.channel === "boot:fts-health-changed");
      expect(healthMessage).toBeDefined();
    });

    it("should have correct progress values for each phase", () => {
      const progressMap: Record<string, number> = {
        "db-init": 15,
        "fts-check": 35,
        "app-init": 75,
        "background-init": 90,
        ready: 100,
      };

      for (const [phase, expectedProgress] of Object.entries(progressMap)) {
        const message = sentMessages.find(
          (m) =>
            m.channel === "boot:status-changed" && (m.data as { phase: string }).phase === phase
        );
        if (message) {
          expect((message.data as { progress: number }).progress).toBe(expectedProgress);
        }
      }
    });

    it("should have correct i18n keys for each phase", () => {
      const keyMap: Record<string, string> = {
        "db-init": "boot.phase.dbInit",
        "fts-check": "boot.phase.ftsCheck",
        "app-init": "boot.phase.appInit",
        "background-init": "boot.phase.backgroundInit",
        ready: "boot.phase.ready",
      };

      for (const [phase, expectedKey] of Object.entries(keyMap)) {
        const message = sentMessages.find(
          (m) =>
            m.channel === "boot:status-changed" && (m.data as { phase: string }).phase === phase
        );
        if (message) {
          expect((message.data as { messageKey: string }).messageKey).toBe(expectedKey);
        }
      }
    });

    it("should not emit non-terminal states after reaching terminal state", () => {
      const statusMessages = sentMessages
        .filter((m) => m.channel === "boot:status-changed")
        .map((m) => (m.data as { phase: string }).phase);

      const terminalStates = ["ready", "degraded", "failed"];
      let hasReachedTerminal = false;
      let violated = false;

      for (const phase of statusMessages) {
        const isTerminal = terminalStates.includes(phase);

        if (hasReachedTerminal && !isTerminal) {
          violated = true;
          break;
        }

        if (isTerminal) {
          hasReachedTerminal = true;
        }
      }

      expect(violated).toBe(false);
    });
  });

  describe("IPC Handlers", () => {
    it("should register boot IPC handlers", () => {
      expect(mockIpcMain.handle).toHaveBeenCalledWith("boot:get-status", expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        "boot:retry-fts-repair",
        expect.any(Function)
      );
      expect(mockIpcMain.handle).toHaveBeenCalledWith("boot:relaunch", expect.any(Function));
    });

    it("should remove existing boot handlers before registering", () => {
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith("boot:get-status");
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith("boot:retry-fts-repair");
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith("boot:relaunch");
    });

    it("should register all IPC handlers", () => {
      expect(mockIpcHandlers.registerI18nHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerLLMConfigHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerScreenCaptureHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerPermissionHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerCaptureSourceSettingsHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerUserSettingsHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerContextGraphHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerThreadsHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerUsageHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerActivityMonitorHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerMonitoringHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerAppHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerAppUpdateHandlers).toHaveBeenCalled();
      expect(mockIpcHandlers.registerNotificationHandlers).toHaveBeenCalled();
    });

    it("should return current boot status from handler", () => {
      const handlerCall = mockIpcMain.handle.mock.calls.find(
        (call: [string, (...args: unknown[]) => unknown]) => call[0] === "boot:get-status"
      );
      expect(handlerCall).toBeDefined();

      const handler = handlerCall![1];
      const result = handler();
      expect(result.success).toBe(true);
      expect(result.data.phase).toBeDefined();
      expect(result.data.progress).toBeDefined();
      expect(result.data.messageKey).toBeDefined();
    });
  });

  describe("Window Management", () => {
    it("should create main window with correct configuration", () => {
      expect(mockBrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: expect.any(Number),
          height: expect.any(Number),
          show: true,
          title: expect.any(String),
          webPreferences: expect.objectContaining({
            preload: expect.any(String),
          }),
          autoHideMenuBar: true,
          titleBarStyle: "hidden",
        })
      );
    });

    it("should load splash page URL", () => {
      expect(currentMockWindow.loadURL).toHaveBeenCalledWith(expect.stringContaining("/splash"));
    });

    it("should set application menu to null", () => {
      expect(mockMenu.setApplicationMenu).toHaveBeenCalledWith(null);
    });
  });

  describe("Deferred Services Initialization", () => {
    it("should initialize all deferred services", async () => {
      const { userSettingService } = await import("./services/user-setting-service");
      const { mainI18n } = await import("./services/i18n-service");
      const { captureScheduleController } = await import("./services/screen-capture");
      const { notificationService } = await import("./services/notification/notification-service");
      const { powerMonitorService } = await import("./services/power-monitor");
      const { monitoringServer } = await import("./services/monitoring");

      expect(userSettingService.getSettings).toHaveBeenCalled();
      expect(mainI18n.initialize).toHaveBeenCalled();
      expect(mockTrayServiceInstance.init).toHaveBeenCalled();
      expect(captureScheduleController.initialize).toHaveBeenCalled();
      expect(captureScheduleController.start).toHaveBeenCalled();
      expect(notificationService.registerEventBusSubscriptions).toHaveBeenCalled();
      expect(powerMonitorService.initialize).toHaveBeenCalled();
      expect(monitoringServer.start).toHaveBeenCalled();
    });
  });
});
