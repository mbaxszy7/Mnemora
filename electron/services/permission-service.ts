/**
 * Permission Service - Manages macOS system permissions for screen capture
 */

import { systemPreferences, shell } from "electron";
import { getLogger } from "./logger";

const logger = getLogger("permission-service");
const isMacOS = () => process.platform === "darwin";

export type PermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export interface PermissionCheckResult {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
}
class PermissionService {
  getScreenRecordingStatus(): PermissionStatus {
    if (!isMacOS()) return "granted";
    try {
      const status = systemPreferences.getMediaAccessStatus("screen");
      return status as PermissionStatus;
    } catch (error) {
      logger.error({ error }, "Failed to check screen recording permission");
      return "unknown";
    }
  }

  getAccessibilityStatus(): PermissionStatus {
    if (!isMacOS()) return "granted";
    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch (error) {
      logger.error({ error }, "Failed to check accessibility permission");
      return "unknown";
    }
  }

  hasScreenRecordingPermission(): boolean {
    return this.getScreenRecordingStatus() === "granted";
  }

  hasAccessibilityPermission(): boolean {
    return this.getAccessibilityStatus() === "granted";
  }

  checkAllPermissions(): PermissionCheckResult {
    return {
      screenRecording: this.getScreenRecordingStatus(),
      accessibility: this.getAccessibilityStatus(),
    };
  }

  async requestScreenRecordingPermission(): Promise<boolean> {
    if (!isMacOS()) return true;

    const status = this.getScreenRecordingStatus();
    if (status === "granted") return true;

    if (status === "denied" || status === "restricted") {
      await this.openScreenRecordingPreferences();
      return false;
    }

    // Trigger permission prompt via desktopCapturer
    try {
      const { desktopCapturer } = await import("electron");
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
      return this.getScreenRecordingStatus() === "granted";
    } catch (error) {
      logger.error({ error }, "Failed to request screen recording permission");
      return false;
    }
  }

  async requestAccessibilityPermission(): Promise<boolean> {
    if (!isMacOS()) return true;
    if (this.getAccessibilityStatus() === "granted") return true;

    try {
      return systemPreferences.isTrustedAccessibilityClient(true);
    } catch (error) {
      logger.error({ error }, "Failed to request accessibility permission");
      return false;
    }
  }

  async openScreenRecordingPreferences(): Promise<void> {
    if (!isMacOS()) return;
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      );
    } catch {
      await shell
        .openExternal("x-apple.systempreferences:com.apple.preference.security")
        .catch(() => {});
    }
  }

  async openAccessibilityPreferences(): Promise<void> {
    if (!isMacOS()) return;
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      );
    } catch {
      await shell
        .openExternal("x-apple.systempreferences:com.apple.preference.security")
        .catch(() => {});
    }
  }
}

// Export singleton instance
export const permissionService = new PermissionService();
