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
}));

// Mock screen capture module
const mockCaptureModule = {
  getState: vi.fn(() => ({ status: "idle" })),
  start: vi.fn(),
  stop: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("./screen-capture", () => ({
  getScreenCaptureModule: vi.fn(() => mockCaptureModule),
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

describe("TrayService", () => {
  let TrayService: typeof import("./tray-service").TrayService;
  let mockOnShowMainWindow: Mock<() => void>;
  let mockOnQuit: Mock<() => void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockOnShowMainWindow = vi.fn<() => void>();
    mockOnQuit = vi.fn<() => void>();

    // Reset module to get fresh instance
    vi.resetModules();
    const module = await import("./tray-service");
    TrayService = module.TrayService;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should store options without creating tray", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      expect(service).toBeDefined();
      // Tray should not be created yet (init not called)
      expect(mockTray.setToolTip).not.toHaveBeenCalled();
    });
  });

  describe("init", () => {
    it("should create tray with icon", async () => {
      const { nativeImage } = await import("electron");

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(nativeImage.createFromPath).toHaveBeenCalled();
      // Verify tray was created by checking that tray methods were called
      expect(mockTray.setToolTip).toHaveBeenCalled();
    });

    it("should set tooltip on init", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockTray.setToolTip).toHaveBeenCalled();
    });

    it("should set context menu on init", async () => {
      const { Menu } = await import("electron");

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(Menu.buildFromTemplate).toHaveBeenCalled();
      expect(mockTray.setContextMenu).toHaveBeenCalled();
    });

    it("should register click and double-click handlers", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockTray.on).toHaveBeenCalledWith("click", expect.any(Function));
      expect(mockTray.on).toHaveBeenCalledWith("double-click", expect.any(Function));
    });

    it("should subscribe to scheduler events", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      expect(mockCaptureModule.on).toHaveBeenCalledWith("scheduler:state", expect.any(Function));
    });

    it("should not reinitialize if already initialized", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.dispose();

      expect(mockCaptureModule.off).toHaveBeenCalledWith("scheduler:state", expect.any(Function));
    });

    it("should remove all tray listeners", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.dispose();

      expect(mockTray.removeAllListeners).toHaveBeenCalled();
    });

    it("should destroy tray", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();
      service.dispose();

      expect(mockTray.destroy).toHaveBeenCalled();
    });

    it("should do nothing if not initialized", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the registered handler
      const schedulerHandler = mockCaptureModule.on.mock.calls.find(
        (call) => call[0] === "scheduler:state"
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
    it("should call onShowMainWindow when tray is clicked", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the click handler
      const clickHandler = mockTray.on.mock.calls.find((call) => call[0] === "click")?.[1];

      expect(clickHandler).toBeDefined();
      clickHandler?.();

      expect(mockOnShowMainWindow).toHaveBeenCalled();
    });

    it("should call onShowMainWindow when tray is double-clicked", () => {
      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
        onQuit: mockOnQuit,
      });

      service.init();

      // Get the double-click handler
      const dblClickHandler = mockTray.on.mock.calls.find(
        (call) => call[0] === "double-click"
      )?.[1];

      expect(dblClickHandler).toBeDefined();
      dblClickHandler?.();

      expect(mockOnShowMainWindow).toHaveBeenCalled();
    });
  });

  describe("toggle recording", () => {
    it("should call start when not running", async () => {
      const { Menu } = await import("electron");
      mockCaptureModule.getState.mockReturnValue({ status: "idle" });

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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

      expect(mockCaptureModule.start).toHaveBeenCalled();
    });

    it("should call stop when running", async () => {
      const { Menu } = await import("electron");
      mockCaptureModule.getState.mockReturnValue({ status: "running" });

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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

      const service = new TrayService({
        iconPath: "/path/to/icon.png",
        onShowMainWindow: mockOnShowMainWindow,
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
      expect(mockCaptureModule.start).not.toHaveBeenCalled();
    });
  });
});
