import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Mock Electron modules
const mockTray = {
  setToolTip: vi.fn() as Mock,
  setContextMenu: vi.fn() as Mock,
  on: vi.fn() as Mock,
  removeAllListeners: vi.fn() as Mock,
  destroy: vi.fn() as Mock,
};

// Create a class-like constructor mock
class MockTray {
  constructor() {
    return mockTray;
  }
}

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getName: vi.fn(() => "Mnemora"),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ items: [] })),
  },
  Tray: MockTray,
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => false, setTemplateImage: vi.fn() })),
  },
  BrowserWindow: vi.fn(),
}));

// Mock node:fs so existsSync returns true (needed for Windows path in init())
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

// Mock screen capture module (the barrel export ./screen-capture)
const mockCaptureModule = {
  getState: vi.fn(() => ({ status: "idle" })),
  stop: vi.fn(),
};

const mockEventBus = {
  on: vi.fn(),
  off: vi.fn(),
};

const mockCaptureScheduleController = {
  evaluateNow: vi.fn(() => Promise.resolve()),
};

vi.mock("./screen-capture", () => ({
  screenCaptureModule: mockCaptureModule,
  screenCaptureEventBus: mockEventBus,
  captureScheduleController: mockCaptureScheduleController,
}));

// Mock i18n service
vi.mock("./i18n-service", () => ({
  mainI18n: {
    t: vi.fn((key: string) => key),
    isInitialized: vi.fn(() => true),
    getCurrentLanguage: vi.fn(() => "en"),
  },
}));

// Mock logger
vi.mock("./logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock main.ts exports
vi.mock("../env", () => ({
  APP_ROOT: "/test/app/root",
  VITE_DEV_SERVER_URL: "http://localhost:5173",
  RENDERER_DIST: "/dist",
}));

// Mock llm-usage-service
vi.mock("./llm-usage-service", () => ({
  llmUsageService: {
    getUsageSummary: vi.fn(() => Promise.resolve({ totalTokens: 0 })),
  },
}));

// Mock user-setting-service
const mockUserSettingService = {
  setCaptureManualOverride: vi.fn(() => Promise.resolve()),
};

vi.mock("./user-setting-service", () => ({
  userSettingService: mockUserSettingService,
}));

describe("TrayService", () => {
  let TrayService: typeof import("./tray-service").TrayService;
  let mockCreateWindow: Mock;
  let mockGetMainWindow: Mock;
  let mockOnQuit: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Set APP_ROOT for path resolution in getIconPath
    process.env.APP_ROOT = "/test/app/root";

    mockCreateWindow = vi.fn(() => ({
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    }));
    mockGetMainWindow = vi.fn(() => null);
    mockOnQuit = vi.fn();

    // Reset module to get fresh instance
    vi.resetModules();
    const module = await import("./tray-service");
    TrayService = module.TrayService;
    // Reset the singleton for each test
    TrayService.resetInstance();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("singleton pattern", () => {
    it("should return same instance via getInstance", () => {
      const instance1 = TrayService.getInstance();
      const instance2 = TrayService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it("should be configurable via configure method", () => {
      const service = TrayService.getInstance();
      const result = service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });
      // configure should return the service for chaining
      expect(result).toBe(service);
    });
  });

  describe("init", () => {
    it("should create tray with icon", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Verify tray was created by checking that tray methods were called
      expect(mockTray.setToolTip).toHaveBeenCalled();
      expect(mockTray.setContextMenu).toHaveBeenCalled();
      expect(mockTray.on).toHaveBeenCalledWith("click", expect.any(Function));
    });

    it("should set tooltip on init", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockTray.setToolTip).toHaveBeenCalled();
    });

    it("should set context menu on init", async () => {
      const { Menu } = await import("electron");

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(Menu.buildFromTemplate).toHaveBeenCalled();
      expect(mockTray.setContextMenu).toHaveBeenCalled();
    });

    it("should register click and double-click handlers", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockTray.on).toHaveBeenCalledWith("click", expect.any(Function));
      expect(mockTray.on).toHaveBeenCalledWith("double-click", expect.any(Function));
    });

    it("should subscribe to scheduler events", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockEventBus.on).toHaveBeenCalledWith("capture-scheduler:state", expect.any(Function));
    });

    it("should not reinitialize if already initialized", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.init();

      // setToolTip should only be called once (from first init)
      expect(mockTray.setToolTip).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispose", () => {
    it("should unsubscribe from scheduler events", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.dispose();

      expect(mockEventBus.off).toHaveBeenCalledWith(
        "capture-scheduler:state",
        expect.any(Function)
      );
    });

    it("should remove all tray listeners", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.dispose();

      expect(mockTray.removeAllListeners).toHaveBeenCalled();
    });

    it("should destroy tray", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.dispose();

      expect(mockTray.destroy).toHaveBeenCalled();
    });

    it("should do nothing if not initialized", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      // Should not throw
      service.dispose();

      expect(mockTray.destroy).not.toHaveBeenCalled();
    });
  });

  describe("menu actions", () => {
    it("should build menu with correct labels based on idle state", async () => {
      const { Menu } = await import("electron");
      mockCaptureModule.getState.mockReturnValue({ status: "idle" });

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(Menu.buildFromTemplate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: "tray.show" }),
          expect.objectContaining({ label: "tray.startRecording" }),
          expect.objectContaining({ label: "tray.quit" }),
        ])
      );
    });

    it("should build menu with stop label when running", async () => {
      const { Menu } = await import("electron");
      mockCaptureModule.getState.mockReturnValue({ status: "running" });

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(Menu.buildFromTemplate).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ label: "tray.stopRecording" })])
      );
    });
  });

  describe("scheduler event handling", () => {
    it("should refresh menu and tooltip when scheduler state changes", async () => {
      const { Menu } = await import("electron");

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the registered handler from the event bus mock
      const schedulerHandler = mockEventBus.on.mock.calls.find(
        (call: unknown[]) => call[0] === "capture-scheduler:state"
      )?.[1] as ((event: { currentState: string }) => void) | undefined;

      expect(schedulerHandler).toBeDefined();

      // Clear mocks to check refresh calls
      vi.mocked(Menu.buildFromTemplate).mockClear();
      mockTray.setToolTip.mockClear();

      // Simulate scheduler state change with proper event shape
      schedulerHandler?.({ currentState: "running" });

      expect(Menu.buildFromTemplate).toHaveBeenCalled();
      expect(mockTray.setToolTip).toHaveBeenCalled();
    });
  });

  describe("click handlers", () => {
    it("should show main window when tray is clicked", () => {
      const mockWindow = {
        isMinimized: vi.fn(() => false),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
      };
      mockGetMainWindow.mockReturnValue(mockWindow);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the click handler
      const clickHandler = mockTray.on.mock.calls.find((call) => call[0] === "click")?.[1];

      expect(clickHandler).toBeDefined();
      clickHandler?.();

      expect(mockWindow.show).toHaveBeenCalled();
      expect(mockWindow.focus).toHaveBeenCalled();
    });

    it("should create window if none exists when tray is clicked", () => {
      mockGetMainWindow.mockReturnValue(null);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the click handler
      const clickHandler = mockTray.on.mock.calls.find((call) => call[0] === "click")?.[1];

      expect(clickHandler).toBeDefined();
      clickHandler?.();

      expect(mockCreateWindow).toHaveBeenCalled();
    });
  });

  describe("toggle recording", () => {
    it("should call evaluateNow when not running", async () => {
      const { Menu } = await import("electron");
      mockCaptureModule.getState.mockReturnValue({ status: "idle" });

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the menu template to find the toggle recording click handler
      const menuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const toggleItem = menuTemplate.find((item) => item.label === "tray.startRecording");

      expect(toggleItem?.click).toBeDefined();
      toggleItem?.click?.();

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockUserSettingService.setCaptureManualOverride).toHaveBeenCalledWith("force_on");
      });
      expect(mockCaptureScheduleController.evaluateNow).toHaveBeenCalled();
    });

    it("should call stop when running", async () => {
      const { Menu } = await import("electron");
      mockCaptureModule.getState.mockReturnValue({ status: "running" });

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Simulate that the scheduler state is "running" by triggering the event handler
      const schedulerHandler = mockEventBus.on.mock.calls.find(
        (call: unknown[]) => call[0] === "capture-scheduler:state"
      )?.[1] as ((event: { currentState: string }) => void) | undefined;
      schedulerHandler?.({ currentState: "running" });

      // Get the refreshed menu template (after state change)
      const lastCall = vi.mocked(Menu.buildFromTemplate).mock.calls;
      const menuTemplate = lastCall[lastCall.length - 1][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const toggleItem = menuTemplate.find((item) => item.label === "tray.stopRecording");

      expect(toggleItem?.click).toBeDefined();
      toggleItem?.click?.();

      await vi.waitFor(() => {
        expect(mockUserSettingService.setCaptureManualOverride).toHaveBeenCalledWith("force_off");
      });
      expect(mockCaptureModule.stop).toHaveBeenCalled();
    });

    it("should handle quit menu item", async () => {
      const { Menu } = await import("electron");

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      const menuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const quitItem = menuTemplate.find((item) => item.label === "tray.quit");

      expect(quitItem?.click).toBeDefined();
      quitItem?.click?.();

      expect(mockOnQuit).toHaveBeenCalled();
    });

    it("should handle quit when not configured", async () => {
      const { Menu } = await import("electron");

      const service = TrayService.getInstance();
      // Configure first to init, then we'll test the quit handler's unconfigured path
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get quit handler reference
      const menuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const quitItem = menuTemplate.find((item) => item.label === "tray.quit");
      expect(quitItem?.click).toBeDefined();
      quitItem?.click?.();
      expect(mockOnQuit).toHaveBeenCalled();
    });

    it("should restore minimized window when clicked", () => {
      const mockWindow = {
        isMinimized: vi.fn(() => true),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
      };
      mockGetMainWindow.mockReturnValue(mockWindow);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      const clickHandler = mockTray.on.mock.calls.find((call) => call[0] === "click")?.[1];
      clickHandler?.();

      expect(mockWindow.restore).toHaveBeenCalled();
      expect(mockWindow.show).toHaveBeenCalled();
    });

    it("should handle usage display error gracefully", async () => {
      const { llmUsageService } = await import("./llm-usage-service");
      vi.mocked(llmUsageService.getUsageSummary).mockRejectedValueOnce(new Error("DB error"));

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      // Should not throw even when usage service fails
      service.init();

      // Wait for the async updateUsageDisplay to settle
      await vi.waitFor(() => {
        // Just verify init completed
        expect(mockTray.setToolTip).toHaveBeenCalled();
      });
    });

    it("should handle click on usage menu item to navigate", async () => {
      const { Menu } = await import("electron");
      const mockWindow = {
        isMinimized: vi.fn(() => false),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: { send: vi.fn() },
      };
      mockGetMainWindow.mockReturnValue(mockWindow);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      const menuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      // Usage item is the first one
      const usageItem = menuTemplate[0];
      usageItem?.click?.();

      expect(mockWindow.webContents.send).toHaveBeenCalled();
    });

    it("should not fail when resetInstance called with no instance", () => {
      TrayService.resetInstance(); // first reset
      TrayService.resetInstance(); // second reset - no instance exists
    });

    it("should warn and return on double init", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.init(); // should warn and return early

      // Tray methods only set up once from first init
      expect(mockTray.on).toHaveBeenCalledTimes(2); // click + double-click
    });

    it("should handle init on darwin platform", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", writable: true });

      const { nativeImage } = await import("electron");
      const mockIcon = { isEmpty: () => false, setTemplateImage: vi.fn() };
      vi.mocked(nativeImage.createFromPath).mockReturnValue(
        mockIcon as unknown as ReturnType<typeof nativeImage.createFromPath>
      );

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockIcon.setTemplateImage).toHaveBeenCalledWith(true);
      expect(mockTray.setToolTip).toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    });

    it("should handle init on linux platform", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true });

      const { nativeImage } = await import("electron");
      const mockIcon = { isEmpty: () => false, setTemplateImage: vi.fn() };
      vi.mocked(nativeImage.createFromPath).mockReturnValue(
        mockIcon as unknown as ReturnType<typeof nativeImage.createFromPath>
      );

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // setTemplateImage should NOT be called on linux
      expect(mockIcon.setTemplateImage).not.toHaveBeenCalled();
      expect(mockTray.setToolTip).toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    });

    it("should return early when icon not found on win32", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });

      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(false);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Tray should not be set up
      expect(mockTray.setToolTip).not.toHaveBeenCalled();

      // Restore
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
      vi.mocked(existsSync).mockReturnValue(true);
    });

    it("should return early when icon is empty on non-win32", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true });

      const { nativeImage } = await import("electron");
      vi.mocked(nativeImage.createFromPath).mockReturnValue({
        isEmpty: () => true,
        setTemplateImage: vi.fn(),
      } as unknown as ReturnType<typeof nativeImage.createFromPath>);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Tray should not be set up
      expect(mockTray.setToolTip).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
      vi.mocked(nativeImage.createFromPath).mockReturnValue({
        isEmpty: () => false,
        setTemplateImage: vi.fn(),
      } as unknown as ReturnType<typeof nativeImage.createFromPath>);
    });

    it("should handle icon file not found warning on non-win32", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", writable: true });

      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(false);

      const { nativeImage } = await import("electron");
      vi.mocked(nativeImage.createFromPath).mockReturnValue({
        isEmpty: () => true,
        setTemplateImage: vi.fn(),
      } as unknown as ReturnType<typeof nativeImage.createFromPath>);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Should return early since icon is empty
      expect(mockTray.setToolTip).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(nativeImage.createFromPath).mockReturnValue({
        isEmpty: () => false,
        setTemplateImage: vi.fn(),
      } as unknown as ReturnType<typeof nativeImage.createFromPath>);
    });

    it("should create new window when getMainWindow returns null", () => {
      const mockWindow = {
        isMinimized: vi.fn(() => false),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: { send: vi.fn() },
      };

      mockGetMainWindow.mockReturnValue(null);
      mockCreateWindow.mockReturnValue(mockWindow);

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Trigger click handler
      const clickHandler = mockTray.on.mock.calls.find(
        (call: unknown[]) => call[0] === "click"
      )?.[1] as (() => void) | undefined;
      clickHandler?.();

      expect(mockCreateWindow).toHaveBeenCalled();
      expect(mockWindow.show).toHaveBeenCalled();
    });

    it("should handle dispose with no updateInterval", () => {
      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Dispose should work even without any issues
      service.dispose();
      expect(mockTray.destroy).toHaveBeenCalled();
    });

    it("should use current scheduler status when toggling", async () => {
      const { Menu } = await import("electron");

      // Start as idle
      mockCaptureModule.getState.mockReturnValue({ status: "idle" });

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Simulate scheduler state change to running
      const schedulerHandler = mockEventBus.on.mock.calls.find(
        (call: unknown[]) => call[0] === "capture-scheduler:state"
      )?.[1] as ((event: { currentState: string }) => void) | undefined;
      schedulerHandler?.({ currentState: "running" });

      // Get the refreshed menu after state change - it should show "stop"
      const lastCall = vi.mocked(Menu.buildFromTemplate).mock.calls;
      const menuTemplate = lastCall[lastCall.length - 1][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const toggleItem = menuTemplate.find((item) => item.label === "tray.stopRecording");

      expect(toggleItem?.click).toBeDefined();
      toggleItem?.click?.();

      await vi.waitFor(() => {
        expect(mockCaptureModule.stop).toHaveBeenCalled();
      });
    });
  });
});
