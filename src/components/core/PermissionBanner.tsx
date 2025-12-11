/**
 * Permission Banner Component
 *
 * Displays a banner at the top of the page when screen recording
 * or accessibility permission is not granted. Provides buttons to
 * grant permission or open system settings.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X, Settings, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PermissionStatus } from "@shared/ipc-types";

interface PermissionBannerProps {
  onPermissionGranted?: () => void;
}

interface PermissionState {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
}

export function PermissionBanner({ onPermissionGranted }: PermissionBannerProps) {
  const { t } = useTranslation();
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  // Check permission status on mount and periodically
  const checkPermission = useCallback(async () => {
    try {
      const result = await window.permissionApi.check();
      if (result.success && result.data) {
        const prevAllGranted =
          permissions?.screenRecording === "granted" && permissions?.accessibility === "granted";
        const newAllGranted =
          result.data.screenRecording === "granted" && result.data.accessibility === "granted";

        setPermissions(result.data);

        // If all permissions just became granted, initialize services
        if (!prevAllGranted && newAllGranted) {
          try {
            await window.permissionApi.initServices();
            console.log("Services initialized after permission grant");
          } catch (error) {
            console.error("Failed to initialize services:", error);
          }

          if (onPermissionGranted) {
            onPermissionGranted();
          }
        }
      }
    } catch (error) {
      console.error("Failed to check permission:", error);
    } finally {
      setIsLoading(false);
    }
  }, [onPermissionGranted, permissions]);

  useEffect(() => {
    checkPermission();

    // Poll for permission changes every 2 seconds when not all granted
    const interval = setInterval(() => {
      if (
        !permissions ||
        permissions.screenRecording !== "granted" ||
        permissions.accessibility !== "granted"
      ) {
        checkPermission();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [checkPermission, permissions]);

  // Handle grant permission button click
  const handleGrantPermission = async () => {
    setIsRequesting(true);
    try {
      // Request screen recording first if needed
      if (permissions?.screenRecording !== "granted") {
        await window.permissionApi.requestScreenRecording();
      }
      // Then request accessibility if needed
      if (permissions?.accessibility !== "granted") {
        await window.permissionApi.requestAccessibility();
      }
      // Re-check permission status
      await checkPermission();
    } catch (error) {
      console.error("Failed to request permission:", error);
    } finally {
      setIsRequesting(false);
    }
  };

  // Handle open settings button click
  const handleOpenSettings = async () => {
    try {
      // Open the settings for the first missing permission
      if (permissions?.screenRecording !== "granted") {
        await window.permissionApi.openScreenRecordingSettings();
      } else if (permissions?.accessibility !== "granted") {
        await window.permissionApi.openAccessibilitySettings();
      }
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  };

  // Check if all permissions are granted
  const allGranted =
    permissions?.screenRecording === "granted" && permissions?.accessibility === "granted";

  // Check if any permission is not-determined (can be requested)
  const canRequest =
    permissions?.screenRecording === "not-determined" ||
    permissions?.accessibility === "not-determined" ||
    permissions?.accessibility === "denied"; // Accessibility can always be requested

  // Don't show banner if loading, dismissed, or all permissions granted
  if (isLoading || isDismissed || allGranted) {
    return null;
  }

  return (
    <Alert variant="destructive" className="mb-4 border-amber-500 bg-amber-50 dark:bg-amber-950/20">
      <AlertTriangle className="h-4 w-4 text-amber-600" />
      <AlertTitle className="text-amber-800 dark:text-amber-200 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          {t("permissions.banner.title")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 -mr-2"
          onClick={() => setIsDismissed(true)}
        >
          <X className="h-4 w-4" />
        </Button>
      </AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300">
        <p className="mb-3">{t("permissions.banner.description")}</p>
        <div className="flex gap-2">
          {canRequest ? (
            <Button
              size="sm"
              onClick={handleGrantPermission}
              disabled={isRequesting}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isRequesting
                ? t("permissions.status.checking")
                : t("permissions.banner.grantButton")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleOpenSettings}
              variant="outline"
              className="border-amber-600 text-amber-700 hover:bg-amber-100"
            >
              <Settings className="h-4 w-4 mr-2" />
              {t("permissions.banner.settingsButton")}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export default PermissionBanner;
