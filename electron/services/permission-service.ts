/**
 * Permission Service
 *
 * Manages system permissions required by the application.
 * On macOS, screen recording permission is required for screen capture.
 */

import { systemPreferences, shell } from "electron";
import { getLogger } from "./logger";

// Lazy logger initialization to avoid issues with app not being ready
let _logger: ReturnType<typeof getLogger> | null = null;
function logger() {
  if (!_logger) {
    _logger = getLogger("permission-service");
  }
  return _logger;
}

/**
 * Permission types that the app may require
 */
export type PermissionType = "screen-recording" | "accessibility";

/**
 * Permission status
 */
export type PermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
}

/**
 * Check if running on macOS
 */
function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Permission Service
 *
 * Provides methods to check and request system permissions.
 * Screen recording permission is required for the screen capture feature.
 */
class PermissionService {
  /**
   * Check screen recording permission status
   *
   * On macOS, uses systemPreferences.getMediaAccessStatus
   * On other platforms, assumes granted (no permission required)
   */
  getScreenRecordingStatus(): PermissionStatus {
    if (!isMacOS()) {
      // On Windows/Linux, screen recording doesn't require explicit permission
      return "granted";
    }

    try {
      const status = systemPreferences.getMediaAccessStatus("screen");
      logger().debug({ status }, "Screen recording permission status");

      switch (status) {
        case "granted":
          return "granted";
        case "denied":
          return "denied";
        case "not-determined":
          return "not-determined";
        case "restricted":
          return "restricted";
        default:
          return "unknown";
      }
    } catch (error) {
      logger().error({ error }, "Failed to check screen recording permission");
      return "unknown";
    }
  }

  /**
   * Check accessibility permission status
   *
   * On macOS, uses systemPreferences.isTrustedAccessibilityClient
   * This permission is needed for AppleScript to enumerate windows across Spaces
   * On other platforms, assumes granted (no permission required)
   */
  getAccessibilityStatus(): PermissionStatus {
    if (!isMacOS()) {
      return "granted";
    }

    try {
      // Check without prompting
      const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);
      logger().debug({ isTrusted }, "Accessibility permission status");

      return isTrusted ? "granted" : "denied";
    } catch (error) {
      logger().error({ error }, "Failed to check accessibility permission");
      return "unknown";
    }
  }

  /**
   * Check if accessibility permission is granted
   */
  hasAccessibilityPermission(): boolean {
    return this.getAccessibilityStatus() === "granted";
  }

  /**
   * Request accessibility permission
   *
   * On macOS, this will trigger the system permission dialog
   */
  async requestAccessibilityPermission(): Promise<boolean> {
    if (!isMacOS()) {
      return true;
    }

    const currentStatus = this.getAccessibilityStatus();
    logger().info({ currentStatus }, "Requesting accessibility permission");

    if (currentStatus === "granted") {
      return true;
    }

    try {
      // This will prompt the user if not already trusted
      const isTrusted = systemPreferences.isTrustedAccessibilityClient(true);
      return isTrusted;
    } catch (error) {
      logger().error({ error }, "Failed to request accessibility permission");
      return false;
    }
  }

  /**
   * Open System Preferences to the Accessibility section
   */
  async openAccessibilityPreferences(): Promise<void> {
    if (!isMacOS()) {
      return;
    }

    try {
      // Open System Preferences > Security & Privacy > Privacy > Accessibility
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      );
      logger().info("Opened Accessibility preferences");
    } catch (error) {
      logger().error({ error }, "Failed to open Accessibility preferences");
      try {
        await shell.openExternal("x-apple.systempreferences:com.apple.preference.security");
      } catch {
        logger().error("Failed to open Security & Privacy preferences");
      }
    }
  }

  /**
   * Check all required permissions
   */
  checkAllPermissions(): PermissionCheckResult {
    return {
      screenRecording: this.getScreenRecordingStatus(),
      accessibility: this.getAccessibilityStatus(),
    };
  }

  /**
   * Check if screen recording permission is granted
   */
  hasScreenRecordingPermission(): boolean {
    return this.getScreenRecordingStatus() === "granted";
  }

  /**
   * Request screen recording permission
   *
   * On macOS, this will trigger the system permission dialog if not determined,
   * or open System Preferences if already denied.
   *
   * Note: On macOS 10.15+, the first call to desktopCapturer.getSources()
   * will trigger the permission prompt if not determined.
   */
  async requestScreenRecordingPermission(): Promise<boolean> {
    if (!isMacOS()) {
      return true;
    }

    const currentStatus = this.getScreenRecordingStatus();
    logger().info({ currentStatus }, "Requesting screen recording permission");

    if (currentStatus === "granted") {
      return true;
    }

    if (currentStatus === "denied" || currentStatus === "restricted") {
      // Permission was denied, need to open System Preferences
      logger().info("Opening System Preferences for screen recording permission");
      await this.openScreenRecordingPreferences();
      return false;
    }

    // For "not-determined", we need to trigger the permission prompt
    // This is done by attempting to use desktopCapturer
    try {
      const { desktopCapturer } = await import("electron");
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });

      // Check status again after the prompt
      const newStatus = this.getScreenRecordingStatus();
      return newStatus === "granted";
    } catch (error) {
      logger().error({ error }, "Failed to request screen recording permission");
      return false;
    }
  }

  /**
   * Open System Preferences to the Screen Recording section
   */
  async openScreenRecordingPreferences(): Promise<void> {
    if (!isMacOS()) {
      return;
    }

    try {
      // Open System Preferences > Security & Privacy > Privacy > Screen Recording
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      );
      logger().info("Opened Screen Recording preferences");
    } catch (error) {
      logger().error({ error }, "Failed to open Screen Recording preferences");
      // Fallback: open general Security & Privacy
      try {
        await shell.openExternal("x-apple.systempreferences:com.apple.preference.security");
      } catch {
        logger().error("Failed to open Security & Privacy preferences");
      }
    }
  }

  /**
   * Check if the app needs to show permission prompt
   * Returns true if any required permission is not granted
   */
  needsPermissionPrompt(): boolean {
    if (!isMacOS()) {
      return false;
    }

    const screenStatus = this.getScreenRecordingStatus();
    const accessibilityStatus = this.getAccessibilityStatus();

    return screenStatus !== "granted" || accessibilityStatus !== "granted";
  }

  /**
   * Check if all required permissions are granted
   */
  hasAllPermissions(): boolean {
    return this.hasScreenRecordingPermission() && this.hasAccessibilityPermission();
  }
}

// Export singleton instance
export const permissionService = new PermissionService();
