/**
 * Power Monitor Service
 *
 * Monitors system power events (suspend/resume, lock/unlock) and provides
 * callback registration for other services to respond to these events.
 */

import { app, BrowserWindow, powerMonitor, powerSaveBlocker } from "electron";
import { getLogger } from "./logger";

const logger = getLogger("power-monitor");

/**
 * Power event types
 */
export type PowerEventType = "suspend" | "resume" | "lock-screen" | "unlock-screen";

/**
 * Power event callback type
 */
export type PowerEventCallback = () => void;

/**
 * Power Monitor Service
 *
 * Manages system power events and provides callback registration
 * for other services to respond to power state changes.
 */
class PowerMonitorService {
  private blockerId?: number;
  private suspendCallbacks: PowerEventCallback[] = [];
  private resumeCallbacks: PowerEventCallback[] = [];
  private lockScreenCallbacks: PowerEventCallback[] = [];
  private unlockScreenCallbacks: PowerEventCallback[] = [];
  private initialized = false;

  /**
   * Register a callback for system suspend events
   */
  registerSuspendCallback(callback: PowerEventCallback): void {
    this.suspendCallbacks.push(callback);
  }

  /**
   * Register a callback for system resume events
   */
  registerResumeCallback(callback: PowerEventCallback): void {
    this.resumeCallbacks.push(callback);
  }

  /**
   * Register a callback for screen lock events
   */
  registerLockScreenCallback(callback: PowerEventCallback): void {
    this.lockScreenCallbacks.push(callback);
  }

  /**
   * Register a callback for screen unlock events
   */
  registerUnlockScreenCallback(callback: PowerEventCallback): void {
    this.unlockScreenCallbacks.push(callback);
  }

  /**
   * Initialize the power monitor service
   * Should be called after app is ready
   */
  initialize(): void {
    if (this.initialized) {
      logger.warn("Power monitor already initialized");
      return;
    }

    this.initialized = true;

    // Start power save blocker to prevent app suspension
    this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
    logger.info("Power save blocker started");

    // Clean up blocker when all windows are closed
    app.on("window-all-closed", () => {
      this.stopBlocker();
    });

    // Listen for system suspend
    powerMonitor.on("suspend", () => {
      logger.info("💤 System is about to sleep");
      this.suspendCallbacks.forEach((callback) => {
        try {
          callback();
        } catch (error) {
          logger.error({ error }, "Error in suspend callback");
        }
      });
      this.notifyRenderer("suspend");
    });

    // Listen for system resume
    powerMonitor.on("resume", () => {
      logger.info("🌞 System has woken up");
      this.resumeCallbacks.forEach((callback) => {
        try {
          callback();
        } catch (error) {
          logger.error({ error }, "Error in resume callback");
        }
      });
      this.notifyRenderer("resume");
    });

    // Listen for screen lock
    powerMonitor.on("lock-screen", () => {
      logger.info("🔒 Screen is locked");
      this.lockScreenCallbacks.forEach((callback) => {
        try {
          callback();
        } catch (error) {
          logger.error({ error }, "Error in lock-screen callback");
        }
      });
      this.notifyRenderer("lock-screen");
    });

    // Listen for screen unlock
    powerMonitor.on("unlock-screen", () => {
      logger.info("🔓 Screen is unlocked");
      this.unlockScreenCallbacks.forEach((callback) => {
        try {
          callback();
        } catch (error) {
          logger.error({ error }, "Error in unlock-screen callback");
        }
      });
      this.notifyRenderer("unlock-screen");
    });

    logger.info("Power monitor initialized");
  }

  /**
   * Notify all renderer windows of a power event
   */
  private notifyRenderer(eventType: PowerEventType): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("power-monitor:event", { eventType });
    });
  }

  /**
   * Stop the power save blocker
   */
  private stopBlocker(): void {
    if (this.blockerId !== undefined && powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId);
      logger.info("Power save blocker stopped");
    }
  }

  /**
   * Cleanup and unregister all listeners
   */
  dispose(): void {
    this.stopBlocker();
    powerMonitor.removeAllListeners();
    this.suspendCallbacks = [];
    this.resumeCallbacks = [];
    this.lockScreenCallbacks = [];
    this.unlockScreenCallbacks = [];
    this.initialized = false;
    logger.info("Power monitor disposed");
  }
}

// Export singleton instance
export const powerMonitorService = new PowerMonitorService();
