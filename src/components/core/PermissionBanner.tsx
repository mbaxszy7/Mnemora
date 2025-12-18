/**
 * Permission Banner Component
 *
 * Displays a banner at the top of the page when screen recording
 * or accessibility permission is not granted. Provides buttons to
 * grant permission or open system settings.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X, Settings, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PermissionStatus } from "@shared/ipc-types";
import { useInitServices } from "@/hooks/use-capture-source";

interface PermissionState {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
}

export function PermissionBanner() {
  const { t } = useTranslation();
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const { initServices } = useInitServices();
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const isGrantedRef = useRef(false);

  const allGranted = useCallback(
    (p?: PermissionState | null) =>
      p?.screenRecording === "granted" && p?.accessibility === "granted",
    []
  );

  // Check permission status on mount and periodically (until granted)
  const checkPermission = useCallback(async () => {
    // Skip calling IPC if we already know everything is granted
    if (isGrantedRef.current || allGranted(permissions)) {
      return;
    }
    try {
      const result = await window.permissionApi.check();
      if (result.success && result.data) {
        setPermissions(result.data);

        // If all permissions just became granted, notify parent
        if (allGranted(result.data)) {
          isGrantedRef.current = true;
          initServices();
        }
      }
    } catch (error) {
      console.error("Failed to check permission:", error);
    } finally {
      setIsLoading(false);
    }
  }, [allGranted, initServices, permissions]);

  useEffect(() => {
    checkPermission();

    // Poll for permission changes every 2 seconds only until granted
    if (isGrantedRef.current || allGranted(permissions)) {
      return;
    }

    const interval = setInterval(() => {
      checkPermission();
    }, 2000);

    return () => clearInterval(interval);
  }, [allGranted, checkPermission, permissions]);

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
  const isAllGranted = allGranted(permissions);

  // Check if any permission is not-determined (can be requested)
  const canRequest =
    permissions?.screenRecording === "not-determined" ||
    permissions?.accessibility === "not-determined" ||
    permissions?.accessibility === "denied"; // Accessibility can always be requested

  // Don't show banner if loading, dismissed, or all permissions granted
  if (isLoading || isDismissed || isAllGranted) {
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
