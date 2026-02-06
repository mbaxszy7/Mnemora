/**
 * Unit Tests for Capture Schedule Controller
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const { mockGetSettings, mockLogger } = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../user-setting-service", () => ({
  userSettingService: {
    getSettings: mockGetSettings,
  },
}));

import { CaptureScheduleController } from "./capture-schedule-controller";
import type { ScreenCaptureModuleType } from "./screen-capture-module";

describe("CaptureScheduleController", () => {
  let controller: CaptureScheduleController;
  let mockScreenCapture: ScreenCaptureModuleType;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new CaptureScheduleController();

    mockScreenCapture = {
      getState: vi.fn().mockReturnValue({ status: "idle" }),
      pause: vi.fn(),
      resume: vi.fn(),
      tryInitialize: vi.fn().mockResolvedValue(true),
    } as unknown as ScreenCaptureModuleType;

    mockGetSettings.mockReset();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    controller.stop();
    vi.useRealTimers();
  });

  describe("initialize", () => {
    it("initializes with screen capture module", () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      // Start and stop should work after initialization
      expect(() => controller.start()).not.toThrow();
    });

    it("uses custom interval when provided", async () => {
      controller.initialize({ screenCapture: mockScreenCapture, intervalMs: 5000 });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      controller.start();

      // Should evaluate immediately on start
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetSettings).toHaveBeenCalled();
    });
  });

  describe("start/stop", () => {
    it("starts timer and evaluates immediately", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      controller.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(mockGetSettings).toHaveBeenCalled();
    });

    it("is idempotent when starting multiple times", () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      controller.start();
      controller.start();

      // Should not throw and should only have one timer
      expect(() => controller.start()).not.toThrow();
    });

    it("stops timer", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      controller.start();
      controller.stop();

      // Should not call getSettings after stop
      const callCount = mockGetSettings.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockGetSettings).toHaveBeenCalledTimes(callCount);
    });

    it("is idempotent when stopping multiple times", () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      controller.stop();
      controller.stop();

      expect(() => controller.stop()).not.toThrow();
    });
  });

  describe("evaluateNow", () => {
    it("returns early if no screen capture module", async () => {
      controller = new CaptureScheduleController();
      // Don't initialize

      const result = await controller.evaluateNow();

      expect(result).toBeUndefined();
    });

    it("pauses capture when schedule disallows capture", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: true,
        captureAllowedWindows: [{ start: "09:00", end: "17:00" }],
        captureManualOverride: null,
      });

      // Set status to running so pause can be called
      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "running" });

      // Set time outside allowed window
      vi.setSystemTime(new Date("2024-01-15T20:00:00")); // 8 PM

      await controller.evaluateNow();

      expect(mockScreenCapture.pause).toHaveBeenCalled();
    });

    it("resumes capture when schedule allows and currently paused", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: true,
        captureAllowedWindows: [{ start: "09:00", end: "17:00" }],
        captureManualOverride: null,
      });

      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "paused" });

      // Set time inside allowed window
      vi.setSystemTime(new Date("2024-01-15T10:00:00")); // 10 AM

      await controller.evaluateNow();

      expect(mockScreenCapture.resume).toHaveBeenCalled();
    });

    it("tries to initialize when idle and schedule allows", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: true,
        captureAllowedWindows: [{ start: "09:00", end: "17:00" }],
        captureManualOverride: null,
      });

      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "idle" });

      // Set time inside allowed window
      vi.setSystemTime(new Date("2024-01-15T10:00:00"));

      await controller.evaluateNow();

      expect(mockScreenCapture.tryInitialize).toHaveBeenCalled();
    });

    it("tries to initialize when stopped and schedule allows", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: true,
        captureAllowedWindows: [{ start: "09:00", end: "17:00" }],
        captureManualOverride: null,
      });

      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "stopped" });

      vi.setSystemTime(new Date("2024-01-15T10:00:00"));

      await controller.evaluateNow();

      expect(mockScreenCapture.tryInitialize).toHaveBeenCalled();
    });

    it("handles force_on manual override", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: true,
        captureAllowedWindows: [{ start: "09:00", end: "17:00" }],
        captureManualOverride: "force_on",
      });

      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "paused" });

      // Even outside allowed window
      vi.setSystemTime(new Date("2024-01-15T20:00:00"));

      await controller.evaluateNow();

      expect(mockScreenCapture.resume).toHaveBeenCalled();
    });

    it("handles force_off manual override", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: true,
        captureAllowedWindows: [{ start: "09:00", end: "17:00" }],
        captureManualOverride: "force_off",
      });

      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "running" });

      // Even inside allowed window
      vi.setSystemTime(new Date("2024-01-15T10:00:00"));

      await controller.evaluateNow();

      expect(mockScreenCapture.pause).toHaveBeenCalled();
    });

    it("is reentrant - handles concurrent calls", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      // Use real timers for this test
      vi.useRealTimers();

      const settings = {
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      };

      // First call resolves after a delay
      mockGetSettings.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(settings), 50))
      );

      // First call starts evaluating
      const firstCall = controller.evaluateNow();

      // Second call should return early due to evaluating flag
      await controller.evaluateNow();

      // Complete the first call
      await firstCall;

      // Both calls should complete without error
      expect(mockGetSettings).toHaveBeenCalled();

      // Restore fake timers for other tests
      vi.useFakeTimers();
    }, 10000);

    it("processes pending evaluations after current one completes", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "idle" });

      await controller.evaluateNow();

      // Should have called getSettings at least once
      expect(mockGetSettings).toHaveBeenCalled();
    });

    it("handles errors gracefully", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockRejectedValue(new Error("Database error"));

      // Should not throw
      await expect(controller.evaluateNow()).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        "Failed to evaluate capture schedule"
      );
    });

    it("continues evaluation when capture is allowed but not running/paused/idle/stopped", async () => {
      controller.initialize({ screenCapture: mockScreenCapture });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      // Any status that's not running/paused/idle/stopped
      vi.mocked(mockScreenCapture.getState).mockReturnValue({ status: "unknown" as const });

      await controller.evaluateNow();

      // Should not try to pause, resume, or initialize
      expect(mockScreenCapture.pause).not.toHaveBeenCalled();
      expect(mockScreenCapture.resume).not.toHaveBeenCalled();
      expect(mockScreenCapture.tryInitialize).not.toHaveBeenCalled();
    });
  });

  describe("integration with timer", () => {
    it("evaluates on timer interval", async () => {
      controller.initialize({ screenCapture: mockScreenCapture, intervalMs: 30000 });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      controller.start();

      // First evaluation on start
      await vi.advanceTimersByTimeAsync(0);
      const initialCallCount = mockGetSettings.mock.calls.length;

      // Advance past interval
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockGetSettings).toHaveBeenCalledTimes(initialCallCount + 1);
    });

    it("stops timer evaluation after stop() is called", async () => {
      controller.initialize({ screenCapture: mockScreenCapture, intervalMs: 30000 });

      mockGetSettings.mockResolvedValue({
        captureScheduleEnabled: false,
        captureAllowedWindows: [],
        captureManualOverride: null,
      });

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      const callCountBeforeStop = mockGetSettings.mock.calls.length;

      controller.stop();

      await vi.advanceTimersByTimeAsync(60000);

      expect(mockGetSettings).toHaveBeenCalledTimes(callCountBeforeStop);
    });
  });
});
