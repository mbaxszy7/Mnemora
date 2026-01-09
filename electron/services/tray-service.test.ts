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
  Menu: {
    buildFromTemplate: vi.fn(() => ({ items: [] })),
  },
  Tray: MockTray,
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => false })),
  },
  BrowserWindow: vi.fn(),
}));

// Mock screen capture module
const mockCaptureModule = {
  getState: vi.fn(() => ({ status: "idle" })),
  tryInitialize: vi.fn(),
  stop: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("./screen-capture/screen-capture-module", () => ({
  screenCaptureModule: mockCaptureModule,
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
    it("should create tray with icon", async () => {
      const { nativeImage } = await import("electron");

      const service = TrayService.getInstance();
      service.configure({
        createWindow: mockCreateWindow,
        getMainWindow: mockGetMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(nativeImage.createFromPath).toHaveBeenCalled();
      // Verify tray was created by checking that tray methods were called
      expect(mockTray.setToolTip).toHaveBeenCalled();
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

      expect(mockCaptureModule.on).toHaveBeenCalledWith(
        "capture-scheduler:state",
        expect.any(Function)
      );
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

      expect(mockCaptureModule.off).toHaveBeenCalledWith(
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

      // Get the registered handler
      const schedulerHandler = mockCaptureModule.on.mock.calls.find(
        (call) => call[0] === "capture-scheduler:state"
      )?.[1];

      expect(schedulerHandler).toBeDefined();

      // Clear mocks to check refresh calls
      vi.mocked(Menu.buildFromTemplate).mockClear();
      mockTray.setToolTip.mockClear();

      // Simulate scheduler state change
      schedulerHandler?.();

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
    it("should call start when not running", async () => {
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

      expect(mockCaptureModule.tryInitialize).toHaveBeenCalled();
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

      // Get the menu template to find the toggle recording click handler
      const menuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const toggleItem = menuTemplate.find((item) => item.label === "tray.stopRecording");

      expect(toggleItem?.click).toBeDefined();
      toggleItem?.click?.();

      expect(mockCaptureModule.stop).toHaveBeenCalled();
    });

    it("should read fresh state when toggling (fix closure issue)", async () => {
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

      // Get the toggle handler from initial menu (shows "start")
      const menuTemplate = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label: string;
        click?: () => void;
      }>;
      const toggleItem = menuTemplate.find((item) => item.label === "tray.startRecording");

      // Now change state to running BEFORE clicking
      mockCaptureModule.getState.mockReturnValue({ status: "running" });

      // Click should read fresh state and call stop (not start based on stale closure)
      toggleItem?.click?.();

      expect(mockCaptureModule.stop).toHaveBeenCalled();
      expect(mockCaptureModule.tryInitialize).not.toHaveBeenCalled();
    });
  });
});
